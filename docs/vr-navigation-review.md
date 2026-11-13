# VR navigation review

Three independent subagents reviewed the runtime before seeing a shared proposal: one examined
gesture mathematics and transitions, one compared comfort/accessibility guidance, and one walked
the editing workflow. Their recommendations were then challenged against the implementation.
This is an engineering and emulator review; it does not establish physical-headset comfort.

## Findings and decisions

| Finding                                                 | Evidence and implemented refinement                                                                                                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Close controllers could cause a large zoom jump         | The old baseline calculation changed from 0.0505× to 1× across a 10.1 mm → 9.9 mm hand span. `WorldGesture` now updates incrementally, pauses scale/yaw below 3 cm, rearms above 5 cm, and rebases across crossings. Midpoint translation remains available. |
| View changes could move a held part                     | A new rig changed the coordinate frame used by a continuing part hold. Navigation now settles and releases editing gestures before changing the view. Tool, selection, and picked points remain. Grip can interrupt an edit on the same controller.          |
| Pointing-ray motion was treated as physical hand motion | Controller poses now use WebXR `gripSpace` for manipulation and `targetRaySpace` for pointing. Tests distinguish the Quest emulator's offset grip and ray.                                                                                                   |
| Arbitrary zoom and world turning needed two hands       | Either grip plus that controller's stick provides anchored zoom and one turn per deflection. Panel controls and an optional explicit world-stick mapping provide alternatives.                                                                               |
| Failed grabs unexpectedly moved the whole world         | Controller trigger misses are inert by default; locked hits select. Legacy trigger navigation remains opt-in. Bare-hand pinch-empty navigation remains available in grab tools.                                                                              |
| Framing included invisible isolated-out parts           | Frame visible and Focus selection use the displayed set. No visible selection disables Focus selection.                                                                                                                                                      |
| Navigation and editing could happen in the same frame   | World-stick intent is resolved before trigger/edit input. Other sticks must return to neutral before editing resumes.                                                                                                                                        |
| Recovering orientation was cumbersome                   | Previous view restores the last complete world gesture or discrete view command, including Keep level mode, independently of scene undo. New scenes clear the old view history.                                                                              |
| Input interruption could leave a stale gesture          | Session visibility events cancel input immediately, including blurred focus. Missing grip or pinch-tip poses end manipulation; resuming tracking alone cannot resume the gesture.                                                                            |
| Disabled controls could drag the panel                  | Disabled rectangles consume input without acting as draggable background. Zoom controls also disable at scale limits.                                                                                                                                        |

## How the consensus was challenged

- **Do not replace the editor stick defaults with walking-game controls.** This is a miniature
  workbench. Existing part-edit bindings remain, with a deliberate grip clutch and optional
  world mapping. Teleportation and walking were not added.
- **Do not smooth the tracked camera to conceal unstable input.** Direct grip translation stays
  one-to-one, with no inertia. Only ambiguous scale/rotation spans pause. The 3/5 cm thresholds
  are engineering defaults that still need hardware validation.
- **Do not recompute the zoom target continuously.** A gesture captures its pivot from an aimed
  surface, visible selection, or visible assembly. A drifting ray cannot drag the zoom anchor.
- **Do not enlarge the panel to fit every control.** The navigation page was reorganized at its
  existing physical size. Undo, redo, no clip, keep level, and exit remain directly accessible.
- Follow-up review caught empty-selection bounds using the scene's fallback box, mapped world
  sticks losing priority to edit sticks, held stick input freezing grip translation, Previous
  view omitting the level setting, and interrupted input retaining stale gestures. These now
  have explicit regression coverage, including immediate visibility-event cancellation without
  an intervening animation frame.

## Guidance applied

Meta recommends accommodating single-controller use, understandable mappings, and a close
relationship between physical and represented controller movement. These informed the one-hand
alternatives and grip-pose correction. [Controller guidance](https://developers.meta.com/vr/design/controllers/).

Meta's navigation guidance emphasizes deliberate input arbitration and reducing accidental
movement. The grip clutch, neutral-to-rearm rule, and separation from part editing apply that
principle to a tabletop editor. [Input maps](https://developers.meta.com/vr/design/locomotion-input-maps/).

Configurable discrete turns and a level default follow the comfort-preferences guidance. World
pulling can still cause vection or fatigue; emulator success cannot establish comfort.
[User preferences](https://developers.meta.com/vr/design/locomotion-user-preferences/),
[comfort and usability](https://developers.meta.com/vr/resources/locomotion-comfort-usability/).

WebXR does not deliver animation callbacks while a session is hidden, and blurred visibility
means the session lacks input focus. Cancellation therefore listens to visibility changes,
with a frame-loop fallback for missing poses. [WebXR visibility](https://www.w3.org/TR/webxr/#dom-xrvisibilitystate-hidden).

## Workflow and validation

1. **Choose and edit a part:** existing tool, paint, precision, and shared undo tests cover this.
   A failed trigger no longer starts navigation.
2. **Navigate to detail:** tests cover fixed-pivot one-controller zoom, turn latching, immediate
   stop, physical grip/ray differences, and same-controller grip interruption during paint.
3. **Recover the work:** tests cover Previous view with matching level mode, without scene
   edits, and isolated-part framing. Focus selection and disabled controls have explicit input
   behavior. Missing controller/finger poses and session interruptions require fresh input.
4. **Return to editing:** tests cover preservation of geometry and alignment work, mixed
   navigation/edit-stick priority, and the neutral requirement after navigation.
5. **Configure controls:** unit tests cover migration of existing bindings, sanitization,
   persistence, and reset. Panel canvas inspection checks layout and hit targets for View,
   World settings, and Bindings. Emulator tests exercise settings through controller rays.

Run `npm test`, `npm run build`, and the `headset`, `headset-session`, `xr-controls`,
`xr-world-controls`, and `preferences` Playwright suites for the combined regression checks.

Still requiring a real Quest 3S: seated reach/readability, either-hand use, controller fatigue,
comfort at extreme magnification, near-crossing hand behavior, and dense-scene latency. No
physical frame-rate or motion-comfort claim is made by these automated checks.
