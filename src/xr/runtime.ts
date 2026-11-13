import { Box3, Group, Matrix4, Quaternion, Raycaster, Triangle, Vector3 } from 'three';
import type { Camera, Mesh, Scene, WebGLRenderer } from 'three';
import { treeOf } from '../core/clipping';
import { sceneBounds, triangleCount } from '../core/geometry';
import { hiddenByIsolation } from '../core/isolation';
import { canRedo, canUndo, useEditor } from '../core/store';
import { readFace } from '../core/surfaces';
import type { Part, Quat, SurfacePoint, Tool, Vec3 } from '../core/types';
import {
  readXRButtons,
  readXRStick,
  useXRInput,
  xrButtons,
  xrButtonActions,
  xrAxisActions,
} from '../core/xr-input';
import type { XRButton, XRButtonAction } from '../core/xr-input';
import {
  xrAdvance,
  xrFinishAdjustment,
  xrBack,
  xrAdjust,
  xrPick,
  xrRunToolAction,
  xrToolButtons,
  xrToolStatus,
} from './editor-tools';
import type { XRToolAction, XRAdjustmentGesture } from './editor-tools';
import { WristPalette } from './wrist';
import { ToolVisuals } from './tool-visuals';
import {
  cloneRig,
  WorldGesture,
  turnRig,
  frameRig,
  heldPose,
  levelRig,
  magnification,
  magnificationLimits,
  rescaleRig,
  scaleLabel,
  toRoom,
  toScene,
} from '../core/xr';
import type { HandPose, Rig } from '../core/xr';
import { exitXR, setXRSettings, useXR } from '../core/xr-session';
import { Panel } from './panel';
import type { PanelAction } from './panel';
import { partMeshes } from './part-meshes';
import { Highlight, PointerVisual, Readout } from './visuals';
import type { Tone } from './visuals';

type Editor = ReturnType<typeof useEditor.getState>;
type Trigger = 'select' | 'squeeze';
type Patch = { id: string; patch: { position: Vec3; quaternion: Quat } };
type WorldView = { rig: Rig; level: boolean };

type Hover =
  | { kind: 'panel'; action: PanelAction | null; point: Vector3; wrist?: boolean }
  | {
      kind: 'part';
      id: string;
      point: Vector3;
      near: boolean;
      surface?: SurfacePoint;
      face?: number;
    };

interface PartHold {
  kind: 'part';
  by: Trigger;
  start: Part[];
  baseline: Part[];
  /** The hand and the point it took the part by, in the scene, when it took hold. */
  grab: HandPose & { pivot: Vector3 };
  near: boolean;
  checkpointed: boolean;
  patches: Patch[] | null;
  applied: HandPose | null;
  /** The last step moved nothing, so the parts are as near the hand as they can get. */
  arrived: boolean;
  contact: boolean;
}

type Action =
  | PartHold
  | { kind: 'world'; by: Trigger }
  | { kind: 'press'; by: Trigger; action: PanelAction; wrist?: boolean }
  | {
      kind: 'paint';
      by: Trigger;
      tool: Tool;
      last: Vector3;
      partId: string;
      erase: boolean;
      radius: number;
      time: number;
    }
  | { kind: 'pick'; by: Trigger }
  | { kind: 'panel'; by: Trigger; offset: Matrix4 };

/** A camera of either projection, and the orbit controls that normally move it. */
type ViewCamera = Camera & { near: number; far: number; updateProjectionMatrix: () => void };
interface ViewControls {
  enabled: boolean;
  update: () => void;
}

// A hand this close to a surface, in the room, takes the part directly instead of pointing.
const touchDistance = 0.02;
const idleBeam = 0.35;
// A headset frame lasts 11 to 14 ms in all, so a held part gets less time to avoid others
// than a mouse drag does. It catches up over the next frames.
const gestureBudget = 5;
// The nearest and farthest the headset draws, in meters.
const nearPlane = 0.02;
const farPlane = 200;
// Fine detail at the edge of view stays sharp below this many triangles and is traded for
// speed above it.
const sharpTriangles = 500_000;
// Tinting a part draws it a second time, which a dense one cannot spare.
const highlightTriangles = 300_000;
const one = new Vector3(1, 1, 1);

class Pointer {
  readonly visual = new PointerVisual();
  /** Tints the part a press would take. */
  readonly highlight = new Highlight();
  /** Where it points from and along, in the room. */
  readonly aim = new Matrix4();
  /** The point that touches and holds, and how the hand is turned, in the room. */
  readonly hand: HandPose = { position: new Vector3(), quaternion: new Quaternion() };
  readonly joints: { position: Vector3; radius: number }[] = [];
  tracked = false;
  hover: Hover | null = null;
  action: Action | null = null;
  events: { trigger: Trigger; down: boolean }[] = [];
  buttons = new Set<XRButton>();
  stickActive = false;
  stickBlocked = true;
  worldTurnArmed = true;
  constructor(readonly source: XRInputSource) {
    this.buttons = readXRButtons(source.handedness, source.gamepad).pressed;
  }

  origin(target = new Vector3()) {
    return target.setFromMatrixPosition(this.aim);
  }
  direction(target = new Vector3()) {
    return target.set(0, 0, -1).transformDirection(this.aim);
  }
  matrix(target = new Matrix4()) {
    return target.compose(this.hand.position, this.hand.quaternion, one);
  }
}

function pulse(source: XRInputSource, strength: number, milliseconds: number) {
  const gamepad = source.gamepad as
    { hapticActuators?: { pulse?: (value: number, duration: number) => unknown }[] } | undefined;
  // Feedback is optional: hands have none, and a controller may refuse it.
  try {
    void Promise.resolve(gamepad?.hapticActuators?.[0]?.pulse?.(strength, milliseconds)).catch(
      () => {},
    );
  } catch {
    return;
  }
}

const count = (triangles: number) =>
  triangles >= 1e6
    ? `${(triangles / 1e6).toFixed(1)}M`
    : triangles >= 1000
      ? `${Math.round(triangles / 1000)}k`
      : `${triangles}`;

/**
 * One headset session: the viewer's place in the scene, their controllers and hands, and what
 * those are holding. The page's own interface is not shown in a headset and no pointer events
 * reach the canvas, so this reads the headset's poses each frame and acts on the editor directly.
 */
export class XRRuntime {
  /** Everything in the room: the camera, the hands, and the panel. Scaled into the scene. */
  readonly root = new Group();
  readonly panel = new Panel();
  readonly wrist = new WristPalette();
  toolsVisible = true;
  precision = false;
  multiSelect = false;
  adjustmentAxis: 'x' | 'y' | 'z' = 'y';
  /** The head, in the room. Standing height until the headset reports where it is. */
  readonly head = new Matrix4().makeTranslation(0, 1.6, 0);
  rig: Rig;
  /** Set once the headset has said where the viewer is, and the model is placed before them. */
  placed = false;
  private readonly pointers = new Map<XRInputSource, Pointer>();
  private readonly readout = new Readout();
  private readonly toolVisuals = new ToolVisuals();
  private inputTime = 0;
  private adjustment: XRAdjustmentGesture | null = null;
  private adjustmentCheckpointed = false;
  private sceneEpoch = useEditor.getState().sceneEpoch;
  private tool = useEditor.getState().tool;
  private readonly raycaster = new Raycaster();
  private readonly triangle = new Triangle();
  private readonly inverse = new Matrix4();
  private world: { key: string; gesture: WorldGesture } | null = null;
  private previousView: WorldView | null = null;
  private viewGesture: { start: WorldView; changed: boolean } | null = null;
  private navigationPivot: Vector3 | null = null;
  private worldStickOwner: Pointer | null = null;
  private parts: Part[] = useEditor.getState().scene.parts;
  private view: {
    camera: ViewCamera;
    parent: Camera['parent'];
    position: Vector3;
    quaternion: Quaternion;
    near: number;
    far: number;
    controls: ViewControls | null;
  } | null = null;
  private stats = { since: 0, last: 0, frames: 0, slowest: 0, moving: 0, moves: 0, text: '' };
  private readonly stop: () => void;

  constructor(
    private readonly gl: WebGLRenderer,
    private readonly scene: Scene,
    private readonly session: XRSession,
  ) {
    this.raycaster.firstHitOnly = true;
    this.rig = frameRig(this.head, this.navigationBounds());
    this.applyRig();
    this.root.add(this.panel.object, this.wrist.object, this.readout.object);
    this.scene.add(this.toolVisuals.object);
    this.panel.object.visible = false;
    scene.add(this.root);
    const queue = (trigger: Trigger, down: boolean) => (event: XRInputSourceEvent) => {
      if (session.visibilityState === 'visible')
        this.pointerFor(event.inputSource).events.push({ trigger, down });
    };
    // Hidden sessions stop delivering animation frames, so cancel at the event itself.
    const visibility = () => this.suspendInput();
    session.addEventListener('visibilitychange', visibility);
    const listeners = {
      selectstart: queue('select', true),
      selectend: queue('select', false),
      squeezestart: queue('squeeze', true),
      squeezeend: queue('squeeze', false),
    };
    for (const [type, listener] of Object.entries(listeners))
      session.addEventListener(type as 'selectstart', listener);
    this.stop = () => {
      session.removeEventListener('visibilitychange', visibility);
      for (const [type, listener] of Object.entries(listeners))
        session.removeEventListener(type as 'selectstart', listener);
    };
    const triangles = this.triangles(useEditor.getState());
    gl.xr.setFoveation(triangles > sharpTriangles ? 1 : 0);
  }

  get magnification() {
    return magnification(this.rig);
  }

  /** The viewport's camera rides on the head for the session, and returns as it was. */
  adopt(camera: ViewCamera, controls: ViewControls | null) {
    this.release();
    this.view = {
      camera,
      controls,
      parent: camera.parent,
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      near: camera.near,
      far: camera.far,
    };
    camera.near = nearPlane;
    camera.far = farPlane;
    this.root.add(camera);
    if (controls) controls.enabled = false;
  }

  release() {
    const view = this.view;
    if (!view) return;
    this.view = null;
    const { camera } = view;
    if (view.parent) view.parent.add(camera);
    else camera.removeFromParent();
    camera.position.copy(view.position);
    camera.quaternion.copy(view.quaternion);
    camera.scale.set(1, 1, 1);
    camera.near = view.near;
    camera.far = view.far;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    if (view.controls) {
      view.controls.enabled = true;
      view.controls.update();
    }
  }

  dispose() {
    this.stop();
    for (const pointer of [...this.pointers.values()]) this.drop(pointer);
    this.release();
    this.scene.remove(this.root);
    this.panel.dispose();
    this.wrist.dispose();
    this.toolVisuals.dispose();
    this.toolVisuals.object.removeFromParent();
    this.readout.dispose();
  }

  update(frame: XRFrame | undefined) {
    const space = this.gl.xr.getReferenceSpace();
    const viewer = frame && space ? frame.getViewerPose(space) : null;
    if (!frame || !space || !viewer || this.session.visibilityState !== 'visible') {
      this.suspendInput();
      return;
    }
    this.head.fromArray(viewer.transform.matrix);
    const state = useEditor.getState();
    if (!this.placed) {
      this.placed = true;
      this.rig = frameRig(this.head, this.navigationBounds());
      this.panel.place(this.head);
      this.panel.object.visible = true;
    }
    if (state.scene.parts !== this.parts) {
      const before = new Set(this.parts.map((part) => part.id));
      this.parts = state.scene.parts;
      // A different scene, or the first parts of an empty one, is set before the viewer afresh.
      if (this.parts.length && !this.parts.some((part) => before.has(part.id))) {
        this.rig = frameRig(this.head, this.navigationBounds());
        this.world = null;
      }
    }
    if (state.sceneEpoch !== this.sceneEpoch) {
      this.cancelGestures(false);
      this.previousView = null;
      this.sceneEpoch = state.sceneEpoch;
    }
    if (state.tool !== this.tool) {
      this.cancelGestures();
      this.tool = state.tool;
    }
    this.track(frame, space);
    const offHand = useXRInput.getState().settings.dominantHand === 'right' ? 'left' : 'right';
    const wrist = [...this.pointers.values()].find(
      (p) => p.tracked && p.source.handedness === offHand,
    );
    this.wrist.object.visible = this.toolsVisible && !!wrist && !this.navigating();
    if (wrist) this.wrist.place(wrist.matrix(), this.head);
    // Draw hit targets before reading input, including on the first session frame.
    this.draw();
    this.moveWorld();
    this.applyRig();
    for (const pointer of this.pointers.values()) this.point(pointer, useEditor.getState());
    this.prepareWorldInput();
    for (const pointer of this.pointers.values()) {
      for (const event of pointer.events.splice(0))
        if (event.down) this.press(pointer, event.trigger);
        else this.letGo(pointer, event.trigger);
    }
    const now = performance.now();
    const dt = this.inputTime ? Math.min(0.05, (now - this.inputTime) / 1000) : 0;
    this.inputTime = now;
    for (const pointer of this.pointers.values()) this.controllerInput(pointer, dt);
    if (![...this.pointers.values()].some((pointer) => pointer.stickActive))
      this.finishAdjustment();
    for (const pointer of this.pointers.values()) this.hold(pointer);
    this.wrist.object.visible = this.toolsVisible && !!wrist && !this.navigating();
    if (!this.navigating()) this.endNavigation();
    // A button may have moved the viewer.
    this.applyRig();
    this.draw();
    this.measure(performance.now());
  }

  private applyRig() {
    const rig = this.rig;
    this.root.position.copy(rig.position);
    this.root.quaternion.copy(rig.quaternion);
    this.root.scale.setScalar(rig.scale);
    this.root.updateMatrixWorld(true);
  }

  private pointerFor(source: XRInputSource) {
    let pointer = this.pointers.get(source);
    if (!pointer) {
      pointer = new Pointer(source);
      pointer.visual.hide();
      this.root.add(pointer.visual.object);
      this.scene.add(pointer.highlight.object);
      this.pointers.set(source, pointer);
    }
    return pointer;
  }

  private drop(pointer: Pointer) {
    if (pointer.action?.kind === 'part') this.settle(pointer.action);
    if (pointer.action?.kind === 'paint') useEditor.getState().endPaintStroke();
    pointer.stickActive = false;
    if (this.worldStickOwner === pointer) this.worldStickOwner = null;
    this.root.remove(pointer.visual.object);
    this.scene.remove(pointer.highlight.object);
    pointer.visual.dispose();
    pointer.highlight.dispose();
    this.pointers.delete(pointer.source);
    if (![...this.pointers.values()].some((pointer) => pointer.stickActive))
      this.finishAdjustment();
  }

  private track(frame: XRFrame, space: XRReferenceSpace) {
    const present = new Set<XRInputSource>();
    for (const source of this.session.inputSources) {
      if (source.targetRayMode !== 'tracked-pointer') continue;
      present.add(source);
      const pointer = this.pointerFor(source);
      const aim = frame.getPose(source.targetRaySpace, space);
      const grip = source.gripSpace ? frame.getPose(source.gripSpace, space) : null;
      pointer.tracked = !!aim && (!source.gripSpace || !!grip || !!source.hand);
      if (!aim || !pointer.tracked) {
        this.loseTracking(pointer);
        continue;
      }
      pointer.aim.fromArray(aim.transform.matrix);
      const hand = grip ? new Matrix4().fromArray(grip.transform.matrix) : pointer.aim;
      pointer.hand.position.setFromMatrixPosition(hand);
      pointer.hand.quaternion.setFromRotationMatrix(hand);
      pointer.joints.length = 0;
      if (source.hand && !this.trackHand(frame, space, source.hand, pointer))
        this.loseTracking(pointer);
    }
    for (const [source, pointer] of [...this.pointers])
      if (!present.has(source)) this.drop(pointer);
  }

  private loseTracking(pointer: Pointer) {
    pointer.tracked = false;
    if (pointer.action?.kind === 'paint') useEditor.getState().endPaintStroke();
    if (pointer.action?.kind === 'part') this.settle(pointer.action);
    pointer.action = null;
    if (this.worldStickOwner === pointer) this.worldStickOwner = null;
    pointer.events.length = 0;
    pointer.buttons = readXRButtons(pointer.source.handedness, pointer.source.gamepad).pressed;
    pointer.stickActive = false;
    pointer.stickBlocked = true;
  }

  /** A bare hand holds things at its pinch, and turns them with the wrist. */
  private trackHand(frame: XRFrame, space: XRReferenceSpace, hand: XRHand, pointer: Pointer) {
    let thumb: Vector3 | null = null,
      index: Vector3 | null = null;
    for (const [name, joint] of hand) {
      const pose = frame.getJointPose?.(joint, space);
      if (!pose) continue;
      const { x, y, z } = pose.transform.position;
      const position = new Vector3(x, y, z);
      pointer.joints.push({ position, radius: pose.radius ?? 0.008 });
      if (name === 'thumb-tip') thumb = position;
      else if (name === 'index-finger-tip') index = position;
      else if (name === 'wrist') {
        const turn = pose.transform.orientation;
        pointer.hand.quaternion.set(turn.x, turn.y, turn.z, turn.w);
      }
    }
    if (!thumb || !index) return false;
    pointer.hand.position.copy(thumb).add(index).multiplyScalar(0.5);
    return true;
  }

  private worldHands() {
    return [...this.pointers.values()]
      .filter((pointer) => pointer.tracked && pointer.action?.kind === 'world')
      .slice(0, 2);
  }

  private navigating() {
    return !!this.worldStickOwner || this.worldHands().length > 0;
  }

  /** Frame only the work the headset can actually see, including isolation. */
  private navigationBounds(selection = false) {
    const state = useEditor.getState();
    const parts = state.scene.parts.filter(
      (part) => this.shown(part, state) && (!selection || state.selected.includes(part.id)),
    );
    return selection && !parts.length ? new Box3() : sceneBounds(parts);
  }

  private pivotFor(pointer?: Pointer) {
    if (pointer?.hover?.kind === 'part') return pointer.hover.point.clone();
    const selection = this.navigationBounds(true);
    return (selection.isEmpty() ? this.navigationBounds() : selection).getCenter(new Vector3());
  }

  private beginNavigation(pointer?: Pointer) {
    if (this.viewGesture) return;
    this.viewGesture = { start: this.worldView(), changed: false };
    this.navigationPivot = this.pivotFor(pointer);
  }

  private endNavigation() {
    this.viewGesture = null;
    this.navigationPivot = null;
    this.world = null;
  }

  private worldView(): WorldView {
    return { rig: cloneRig(this.rig), level: useXR.getState().settings.level };
  }

  private changeRig(next: Rig, level = useXR.getState().settings.level) {
    if (
      next.position.distanceToSquared(this.rig.position) < 1e-12 &&
      Math.abs(next.scale - this.rig.scale) < 1e-9 &&
      next.quaternion.angleTo(this.rig.quaternion) < 1e-8 &&
      level === useXR.getState().settings.level
    )
      return;
    if (!this.viewGesture || !this.viewGesture.changed) {
      this.previousView = this.viewGesture?.start ?? this.worldView();
      if (this.viewGesture) this.viewGesture.changed = true;
    }
    this.rig = next;
    if (level !== useXR.getState().settings.level) setXRSettings({ level });
  }

  private takeWorld(pointer: Pointer, by: Trigger) {
    // A world clutch ends scene edits before the coordinate frame can change beneath them.
    if (!this.navigating()) {
      this.cancelGestures();
      this.beginNavigation(pointer);
    }
    pointer.action = { kind: 'world', by };
  }

  /** Hands translate immediately; the math helper pauses ambiguous scale/yaw spans. */
  private moveWorld(rebase = false) {
    const hands = this.worldHands();
    const key = hands.map((pointer) => [...this.pointers.values()].indexOf(pointer)).join();
    if (!hands.length) {
      this.world = null;
      return;
    }
    this.beginNavigation();
    const poses = hands.map((pointer) => pointer.hand.position.clone());
    const level = useXR.getState().settings.level;
    if (rebase || this.world?.key !== key) {
      this.world = { key, gesture: new WorldGesture(this.rig, poses, level, this.precision) };
      return;
    }
    this.changeRig(this.world.gesture.update(poses, level, this.precision));
  }

  private shown(part: Part, state: Editor) {
    return part.visible && !hiddenByIsolation(state.isolated, state.nearbyParts, part.id);
  }

  /** What a press would act on: a part within touch, the panel, or a part pointed at. */
  private point(pointer: Pointer, state: Editor) {
    pointer.hover = null;
    const action = pointer.action;
    if (!pointer.tracked || (action && !['press', 'paint'].includes(action.kind))) return;
    const origin = pointer.origin(),
      direction = pointer.direction();
    const offHand = useXRInput.getState().settings.dominantHand === 'right' ? 'left' : 'right';
    const wrist =
      this.wrist.object.visible && pointer.source.handedness !== offHand
        ? this.wrist.hit(origin, direction)
        : null;
    const panel = this.panel.object.visible ? this.panel.hit(origin, direction) : null;
    const hit =
      wrist && (!panel || wrist.distance <= panel.distance) ? { ...wrist, wrist: true } : panel;
    const ui: Hover | null = hit
      ? { kind: 'panel', action: hit.action, point: hit.point, wrist: 'wrist' in hit }
      : null;
    // A press only needs to know whether it is still over its button.
    if (action?.kind === 'press') {
      pointer.hover = ui;
      return;
    }
    // UI consumes the ray even with a part behind it. Surface tools always use exact ray hits.
    const surfaceTool = ['align', 'joint', 'measure', 'anchors'].includes(state.tool);
    pointer.hover =
      ui ??
      (!surfaceTool ? this.touch(pointer, state) : null) ??
      this.cast(origin, direction, state);
  }

  /** The part whose surface the hand is touching or has reached into. */
  private touch(pointer: Pointer, state: Editor): Hover | null {
    const rig = this.rig;
    const hand = toScene(rig, pointer.hand.position);
    const reach = touchDistance * rig.scale;
    const local = new Vector3(),
      normal = new Vector3(),
      closest = { point: new Vector3(), distance: 0, faceIndex: 0 };
    let best: { id: string; point: Vector3; distance: number; size: number } | null = null;
    for (const part of state.scene.parts) {
      const mesh = partMeshes.get(part.id);
      if (!mesh || !this.shown(part, state)) continue;
      if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
      const box = part.geometry.boundingBox!;
      const elements = mesh.matrixWorld.elements;
      const stretch = [0, 4, 8].map((i) =>
        Math.hypot(elements[i], elements[i + 1], elements[i + 2]),
      );
      const smallest = Math.min(...stretch);
      local.copy(hand).applyMatrix4(this.inverse.copy(mesh.matrixWorld).invert());
      if (!(smallest > 0) || box.distanceToPoint(local) * smallest > reach) continue;
      const tree = treeOf(part.geometry);
      if (!tree) continue;
      if (!tree.closestPointToPoint(local, closest)) continue;
      readFace(part.geometry, closest.faceIndex, this.triangle).getNormal(normal);
      // Behind the nearest surface means inside the part, however far from that surface.
      const inside = box.containsPoint(local) && normal.dot(local.sub(closest.point)) < 0;
      const point = closest.point.clone().applyMatrix4(mesh.matrixWorld);
      const away = point.distanceTo(hand);
      if (!inside && away > reach) continue;
      // A surface under the hand counts for more than being deep inside some other part.
      const distance = Math.min(away, reach);
      const size = box.getSize(local).length() * Math.max(...stretch);
      // Deep inside several parts takes the smallest, which the others would otherwise hide.
      if (!best || distance < best.distance || (distance === best.distance && size < best.size))
        best = { id: part.id, point: away > reach ? hand.clone() : point, distance, size };
    }
    return best ? { kind: 'part', id: best.id, point: best.point, near: true } : null;
  }

  /** The part a ray from the room meets first. */
  private cast(origin: Vector3, direction: Vector3, state: Editor): Hover | null {
    const rig = this.rig;
    const meshes: Mesh[] = [];
    for (const part of state.scene.parts) {
      const mesh = partMeshes.get(part.id);
      if (mesh && this.shown(part, state)) meshes.push(mesh);
    }
    this.raycaster.set(
      toScene(rig, origin),
      direction.clone().applyQuaternion(rig.quaternion).normalize(),
    );
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    return hit
      ? {
          kind: 'part',
          id: hit.object.name.slice('part:'.length),
          point: hit.point.clone(),
          near: false,
          face: hit.faceIndex ?? undefined,
          surface: {
            partId: hit.object.name.slice('part:'.length),
            point: hit.point
              .clone()
              .applyMatrix4(this.inverse.copy(hit.object.matrixWorld).invert())
              .toArray(),
            normal: hit.face?.normal.toArray() ?? [0, 1, 0],
          },
        }
      : null;
  }

  private sceneHand(pointer: Pointer): HandPose {
    const rig = this.rig;
    return {
      position: toScene(rig, pointer.hand.position),
      quaternion: rig.quaternion.clone().multiply(pointer.hand.quaternion),
    };
  }

  private press(pointer: Pointer, by: Trigger) {
    if (!pointer.tracked) return;
    if (by === 'squeeze') {
      this.takeWorld(pointer, by);
      return;
    }
    if (pointer.action) return;
    const hover = pointer.hover;
    if (by === 'select' && hover?.kind === 'panel') {
      pointer.action = hover.action
        ? { kind: 'press', by, action: hover.action, wrist: hover.wrist }
        : {
            kind: 'panel',
            by,
            offset: pointer.matrix().invert().multiply(this.panel.object.matrix),
          };
      if (hover.wrist && !hover.action) pointer.action = { kind: 'pick', by };
      return;
    }
    if (this.navigating()) {
      pointer.action = { kind: 'pick', by };
      return;
    }
    const state = useEditor.getState();
    if (by === 'select' && ['align', 'joint', 'measure', 'anchors'].includes(state.tool)) {
      // A surface-tool miss must never move the assembly or the world.
      pointer.action = { kind: 'pick', by };
      if (hover?.kind === 'part' && hover.surface) {
        if (state.tool === 'align' && state.operation.mode === 'surface') {
          if (
            hover.face !== undefined &&
            !state.painting &&
            state.paintSurface(hover.surface, hover.face, false, true)
          )
            pointer.action = {
              kind: 'paint',
              by,
              tool: state.tool,
              last: hover.point.clone(),
              partId: hover.id,
              erase: state.brushErase,
              radius: state.brushRadius,
              time: performance.now(),
            };
        } else {
          xrPick(hover.surface, hover.face ?? null);
          pulse(pointer.source, 0.25, 20);
        }
      }
      return;
    }
    if (by === 'select' && this.multiSelect) {
      state.select(hover?.kind === 'part' ? hover.id : null, true);
      pointer.action = { kind: 'pick', by };
      return;
    }
    if (by === 'select' && hover?.kind === 'part' && this.take(pointer, hover, by)) return;
    // A missed controller grab cannot unexpectedly move the whole view. Bare hands retain
    // their pinch-empty navigation path because they have no physical grip button.
    const legacyWorld =
      useXRInput.getState().settings.triggerWorld &&
      (!hover ||
        (hover.kind === 'part' && state.scene.parts.find((part) => part.id === hover.id)?.locked));
    if ((!hover && pointer.source.hand) || legacyWorld) {
      this.takeWorld(pointer, by);
    } else {
      if (hover?.kind === 'part') state.select(hover.id);
      pointer.action = { kind: 'pick', by };
    }
  }

  private take(pointer: Pointer, hover: Extract<Hover, { kind: 'part' }>, by: Trigger) {
    let state = useEditor.getState();
    const part = state.scene.parts.find((candidate) => candidate.id === hover.id);
    if (!part || part.locked || state.view.explode > 0 || state.view.inspection.enabled)
      return false;
    if (!state.selected.includes(part.id)) {
      state.select(part.id);
      state = useEditor.getState();
    }
    const hand = this.sceneHand(pointer);
    pointer.action = {
      kind: 'part',
      by,
      start: state.scene.parts.filter(
        (candidate) =>
          state.selected.includes(candidate.id) &&
          !candidate.locked &&
          this.shown(candidate, state),
      ),
      baseline: state.scene.parts,
      grab: { ...hand, pivot: hover.near ? hand.position.clone() : hover.point.clone() },
      near: hover.near,
      checkpointed: false,
      patches: null,
      applied: null,
      arrived: false,
      contact: false,
    };
    pulse(pointer.source, 0.4, 25);
    return true;
  }

  private letGo(pointer: Pointer, by: Trigger) {
    const action = pointer.action;
    if (!action || action.by !== by) return;
    pointer.action = null;
    if (action.kind === 'part') this.settle(action);
    else if (action.kind === 'paint') useEditor.getState().endPaintStroke();
    else if (
      action.kind === 'press' &&
      pointer.hover?.kind === 'panel' &&
      pointer.hover.action === action.action &&
      pointer.hover.wrist === action.wrist
    )
      this.run(action.action);
  }

  private hold(pointer: Pointer) {
    const action = pointer.action;
    if (!action || !pointer.tracked) return;
    if (action.kind === 'paint') {
      const state = useEditor.getState(),
        hover = pointer.hover;
      if (state.tool !== action.tool || !state.painting) {
        pointer.action = null;
        return;
      }
      if (
        hover?.kind === 'part' &&
        hover.surface &&
        hover.face !== undefined &&
        performance.now() - action.time >= 30 &&
        (hover.id !== action.partId ||
          action.erase !== state.brushErase ||
          action.radius !== state.brushRadius ||
          hover.point.distanceTo(action.last) > state.brushRadius * 0.1)
      ) {
        state.paintSurface(hover.surface, hover.face);
        action.last.copy(hover.point);
        action.partId = hover.id;
        action.erase = state.brushErase;
        action.radius = state.brushRadius;
        action.time = performance.now();
      }
    } else if (action.kind === 'part') this.carry(pointer, action);
    else if (action.kind === 'panel') {
      const panel = this.panel.object;
      panel.matrix.copy(pointer.matrix()).multiply(action.offset);
      panel.matrix.decompose(panel.position, panel.quaternion, panel.scale);
    }
  }

  private carry(pointer: Pointer, action: PartHold) {
    const state = useEditor.getState();
    // Undo, or someone else in a shared scene, may have removed what is being held.
    if (action.start.some((part) => !state.scene.parts.some((other) => other.id === part.id))) {
      pointer.action = null;
      return;
    }
    const rawHand = this.sceneHand(pointer);
    const hand = this.precision
      ? {
          position: action.grab.position.clone().lerp(rawHand.position, 0.1),
          quaternion: action.grab.quaternion.clone().slerp(rawHand.quaternion, 0.1),
        }
      : rawHand;
    // A part held back by another keeps closing on a hand that has stopped, until it is there.
    if (
      action.arrived &&
      action.applied &&
      hand.position.distanceToSquared(action.applied.position) < 1e-6 &&
      hand.quaternion.angleTo(action.applied.quaternion) < 1e-5
    )
      return;
    action.applied = hand;
    const patches = action.start.map((part) => ({
      id: part.id,
      patch: heldPose(part, action.grab, hand),
    }));
    action.patches = patches;
    const began = performance.now();
    // The first real movement starts the undo step, so a press without one adds none.
    state.transformMany(patches, !action.checkpointed, true, false, gestureBudget);
    this.stats.moving += performance.now() - began;
    this.stats.moves++;
    const parts = useEditor.getState().scene.parts;
    action.arrived = parts === state.scene.parts;
    if (!action.arrived) {
      action.checkpointed = true;
      this.follow(state.scene.parts, parts);
    }
    const lead = parts.find((part) => part.id === patches[0].id);
    const wanted = patches[0].patch.position;
    // Held back from where the hand asked for, by another part or by a joint.
    const contact =
      !!lead &&
      Math.hypot(...lead.position.map((value, i) => value - wanted[i])) > 0.0005 * this.rig.scale;
    if (contact && !action.contact) pulse(pointer.source, 0.6, 30);
    action.contact = contact;
  }

  /** The drag kept each frame short, so finish avoiding other parts now that it has ended. */
  private settle(action: PartHold) {
    const state = useEditor.getState();
    if (!action.checkpointed || !action.patches || !state.view.clip.enabled) return;
    state.transformMany(action.patches, false, true, true, undefined, action.baseline);
    this.follow(state.scene.parts, useEditor.getState().scene.parts);
  }

  /** Moves the drawn parts now, a frame before the interface catches up, so they keep with the hand. */
  private follow(before: Part[], after: Part[]) {
    after.forEach((part, i) => {
      const group = part === before[i] ? null : partMeshes.get(part.id)?.parent;
      if (!group) return;
      group.position.fromArray(part.position);
      group.quaternion.fromArray(part.quaternion);
      group.scale.fromArray(part.scale);
    });
  }

  /** One transform/undo gesture spans both sticks until they both return to neutral. */
  private finishAdjustment(settle = true) {
    if (settle && this.adjustment && this.adjustmentCheckpointed) {
      const before = useEditor.getState().scene.parts;
      xrFinishAdjustment(this.adjustment);
      this.follow(before, useEditor.getState().scene.parts);
      this.rebaseHolds();
    }
    this.adjustment = null;
    this.adjustmentCheckpointed = false;
  }

  /** Release transient input before a tool, history, scene, or tracking change. */
  private cancelGestures(settle = true) {
    useEditor.getState().endPaintStroke();
    this.finishAdjustment(settle);
    for (const pointer of this.pointers.values()) {
      if (settle && pointer.action?.kind === 'part') this.settle(pointer.action);
      pointer.action = null;
      pointer.stickActive = false;
      pointer.stickBlocked = true;
    }
    this.worldStickOwner = null;
    this.endNavigation();
  }

  private suspendInput() {
    this.cancelGestures();
    this.inputTime = 0;
    for (const pointer of this.pointers.values()) {
      pointer.events.length = 0;
      pointer.buttons = readXRButtons(pointer.source.handedness, pointer.source.gamepad).pressed;
    }
  }

  /** Continue holding from the adjusted pose without snapping back on the next frame. */
  private rebaseHolds() {
    const parts = useEditor.getState().scene.parts;
    for (const pointer of this.pointers.values()) {
      const hold = pointer.action;
      if (hold?.kind !== 'part') continue;
      hold.start = parts.filter((part) => hold.start.some((before) => before.id === part.id));
      if (!hold.start.length) {
        pointer.action = null;
        continue;
      }
      const hand = this.sceneHand(pointer);
      hold.grab = { ...hand, pivot: hand.position.clone() };
      hold.patches = null;
      hold.applied = null;
      hold.arrived = false;
    }
  }

  /** Resolve mapped navigation before either controller can edit in this frame. */
  private prepareWorldInput() {
    if (this.navigating()) return;
    const input = useXRInput.getState().settings;
    const pointer = [...this.pointers.values()].find((pointer) => {
      const hand = pointer.source.handedness;
      return (
        pointer.tracked &&
        !pointer.stickBlocked &&
        pointer.hover?.kind !== 'panel' &&
        (hand === 'left' || hand === 'right') &&
        input.axes[hand] === 'world' &&
        readXRStick(pointer.source.gamepad, input.deadzone).some((value) => value !== 0)
      );
    });
    if (!pointer) return;
    this.cancelGestures();
    pointer.stickBlocked = false;
    this.beginNavigation(pointer);
    this.worldStickOwner = pointer;
  }

  private controllerInput(pointer: Pointer, dt: number) {
    if (!pointer.tracked) return;
    const input = useXRInput.getState().settings;
    const buttons = readXRButtons(
      pointer.source.handedness,
      pointer.source.gamepad,
      pointer.buttons,
    );
    pointer.buttons = buttons.pressed;
    for (const button of buttons.down) this.boundAction(input.buttons[button], pointer);
    const hand = pointer.source.handedness;
    if (hand !== 'left' && hand !== 'right') return;
    const [x, y] = readXRStick(pointer.source.gamepad, input.deadzone);
    const worldHands = this.worldHands();
    const worldMode = input.axes[hand] === 'world';
    if (worldHands.length || this.worldStickOwner || worldMode || this.viewGesture) {
      this.worldInput(pointer, dt, x, y, worldMode);
      return;
    }
    if (!x && !y) {
      pointer.stickActive = false;
      pointer.stickBlocked = false;
      return;
    }
    pointer.stickActive = false;
    if (pointer.stickBlocked) return;
    const mode = input.axes[hand];
    if (
      !dt ||
      mode === 'none' ||
      mode === 'world' ||
      buttons.down.length ||
      pointer.hover?.kind === 'panel' ||
      [...this.pointers.values()].some(
        (p) => p.action?.kind === 'world' || p.action?.kind === 'press',
      )
    )
      return;
    const axis = Math.abs(x) >= Math.abs(y) ? 'x' : 'y';
    const held = [...this.pointers.values()].find((p) => p.action?.kind === 'part')?.action as
      PartHold | undefined;
    const state = useEditor.getState();
    pointer.stickActive = true;
    this.adjustment ??= { baseline: state.scene.parts, patches: null };
    const changed = xrAdjust(
      axis,
      (axis === 'x' ? x : -y) * dt,
      mode,
      this.precision,
      !this.adjustmentCheckpointed && !held?.checkpointed,
      this.adjustmentAxis,
      this.adjustment,
    );
    if (changed && useEditor.getState().scene.parts !== state.scene.parts) {
      this.adjustmentCheckpointed = true;
      if (held) held.checkpointed = true;
      this.follow(state.scene.parts, useEditor.getState().scene.parts);
      this.rebaseHolds();
    }
  }

  /** One controller can navigate; grips clutch into this without replacing edit bindings. */
  private worldInput(pointer: Pointer, dt: number, x: number, y: number, mapped: boolean) {
    pointer.stickActive = false;
    const hands = this.worldHands();
    if (!x && !y) {
      pointer.stickBlocked = false;
      pointer.worldTurnArmed = true;
      if (this.worldStickOwner === pointer) this.worldStickOwner = null;
      return;
    }
    const gripped = hands.length === 1 && hands[0] === pointer;
    if (
      hands.length > 1 ||
      (!gripped && (!mapped || hands.length)) ||
      pointer.stickBlocked ||
      (this.worldStickOwner && this.worldStickOwner !== pointer) ||
      (!gripped && pointer.hover?.kind === 'panel')
    ) {
      // Deflections made in another navigation mode must be released before editing resumes.
      pointer.stickBlocked = true;
      return;
    }
    if (!this.navigating()) {
      this.cancelGestures();
      // This is an explicit world mapping, so the deflection itself starts navigation.
      pointer.stickBlocked = false;
      this.beginNavigation(pointer);
    }
    this.worldStickOwner = pointer;
    const pivot = this.navigationPivot ?? this.pivotFor(pointer);
    const settings = useXRInput.getState().settings;
    const before = this.rig;
    if (Math.abs(y) > Math.abs(x)) {
      if (dt)
        this.changeRig(
          rescaleRig(
            this.rig,
            pivot,
            this.magnification *
              Math.exp(-y * dt * settings.zoomSpeed * (this.precision ? 0.1 : 1)),
          ),
        );
    } else if (Math.abs(x) >= 0.65 && pointer.worldTurnArmed) {
      this.changeRig(turnRig(this.rig, pivot, (Math.sign(x) * settings.turnAngle * Math.PI) / 180));
      pointer.worldTurnArmed = false;
      pulse(pointer.source, 0.25, 20);
    }
    // The hand drag continues from the new view, never from a pre-zoom baseline.
    if (this.rig !== before) this.moveWorld(true);
  }

  private boundAction(action: XRButtonAction, pointer: Pointer) {
    const state = useEditor.getState();
    if (this.navigating() && ['advance', 'back', 'erase'].includes(action)) return;
    switch (action) {
      case 'none':
        return;
      case 'tools':
        this.toolsVisible = !this.toolsVisible;
        break;
      case 'panel':
        this.panel.place(this.head);
        break;
      case 'frame':
        this.run('reset');
        break;
      case 'previousView':
        this.run('previousView');
        break;
      case 'precision':
        this.precision = !this.precision;
        this.rebaseHolds();
        break;
      case 'erase':
        state.setBrush({ erase: !state.brushErase });
        break;
      case 'undo':
      case 'redo':
        this.run(action);
        break;
      case 'back':
        this.cancelGestures();
        xrBack();
        break;
      case 'advance': {
        const dominant =
          [...this.pointers.values()].find(
            (p) => p.tracked && p.source.handedness === useXRInput.getState().settings.dominantHand,
          ) ?? pointer;
        const hover = dominant.hover;
        // UI rays are never interpreted as a surface selection behind the panel.
        if (hover?.kind === 'panel') return;
        this.cancelGestures();
        xrAdvance(hover?.kind === 'part' ? hover.surface : null);
        break;
      }
    }
    pulse(pointer.source, 0.2, 15);
  }

  private inputHints() {
    const input = useXRInput.getState().settings;
    const key = (action: XRButtonAction) =>
      xrButtons
        .filter((button) => input.buttons[button] === action)
        .map((button) =>
          button === 'leftStick'
            ? 'L click'
            : button === 'rightStick'
              ? 'R click'
              : button.toUpperCase(),
        )
        .join('/') || 'Panel';
    if (this.navigating() || this.panel.page === 'view' || this.panel.page === 'world')
      return [
        'Grip: move world · two grips: resize / turn',
        `Grip + stick: up/down zoom · left/right turn ${input.turnAngle}°`,
        `${key('panel')}: panel · Previous view restores navigation`,
      ];
    return [
      `${key('advance')}: next · ${key('back')}: back · ${key('precision')}: precision`,
      `Grip: move world · ${key('tools')}: wrist · ${key('panel')}: panel`,
      `L stick: ${xrAxisActions.find((a) => a.id === input.axes.left)?.label} · R: ${xrAxisActions.find((a) => a.id === input.axes.right)?.label}`,
    ];
  }

  private run(action: PanelAction) {
    if (action === 'noop') return;
    if (this.panel.navigate(action)) return;
    if (action.startsWith('tool:')) {
      this.cancelGestures();
      useEditor.getState().setTool(action.slice(5) as Tool);
      this.panel.page = 'tool';
      return;
    }
    if (action.startsWith('edit:')) {
      this.cancelGestures();
      xrRunToolAction(action.slice(5) as XRToolAction);
      return;
    }
    if (action.startsWith('bind:')) {
      const { settings, setSettings, reset } = useXRInput.getState();
      if (action === 'bind:reset') reset();
      else if (action === 'bind:zoomSpeed') {
        const choices = [0.25, 0.5, 1, 1.5, 2];
        setSettings({
          zoomSpeed: choices.find((speed) => speed > settings.zoomSpeed) ?? choices[0],
        });
      } else if (action === 'bind:turnAngle') {
        setSettings({
          turnAngle: settings.turnAngle === 15 ? 30 : settings.turnAngle === 30 ? 45 : 15,
        });
      } else if (action === 'bind:triggerWorld')
        setSettings({ triggerWorld: !settings.triggerWorld });
      else if (action === 'bind:dominantHand')
        setSettings({ dominantHand: settings.dominantHand === 'left' ? 'right' : 'left' });
      else if (action.startsWith('bind:button:')) {
        const button = action.slice(12) as XRButton;
        const index = xrButtonActions.findIndex((option) => option.id === settings.buttons[button]);
        setSettings({
          buttons: {
            ...settings.buttons,
            [button]: xrButtonActions[(index + 1) % xrButtonActions.length].id,
          },
        });
      } else if (action.startsWith('bind:axis:')) {
        const hand = action.slice(10) as 'left' | 'right';
        const index = xrAxisActions.findIndex((option) => option.id === settings.axes[hand]);
        setSettings({
          axes: { ...settings.axes, [hand]: xrAxisActions[(index + 1) % xrAxisActions.length].id },
        });
      }
      return;
    }
    const state = useEditor.getState();
    const center = () => this.pivotFor();
    const rig = this.rig;
    if (
      [
        'level',
        'trueSize',
        'reset',
        'zoomIn',
        'zoomOut',
        'turnLeft',
        'turnRight',
        'focusSelection',
        'previousView',
      ].includes(action)
    ) {
      this.cancelGestures();
    }
    switch (action) {
      case 'precision':
        this.precision = !this.precision;
        this.rebaseHolds();
        break;
      case 'multiSelect':
        this.multiSelect = !this.multiSelect;
        break;
      case 'axis':
        this.adjustmentAxis =
          this.adjustmentAxis === 'x' ? 'y' : this.adjustmentAxis === 'y' ? 'z' : 'x';
        break;
      case 'undo':
      case 'redo':
        this.cancelGestures();
        if (
          action === 'undo' &&
          state.tool === 'align' &&
          state.operation.mode === 'surface' &&
          state.paintHistory.length
        )
          state.undoPaintStroke();
        else state[action]();
        break;
      case 'clip':
        state.setView({ clip: { ...state.view.clip, enabled: !state.view.clip.enabled } });
        break;
      case 'level': {
        const level = !useXR.getState().settings.level;
        this.changeRig(level ? levelRig(rig, center()) : rig, level);
        break;
      }
      case 'trueSize':
        this.changeRig(rescaleRig(rig, center(), 1));
        break;
      case 'reset':
        this.changeRig(frameRig(this.head, this.navigationBounds()));
        break;
      case 'zoomIn':
      case 'zoomOut':
        this.changeRig(
          rescaleRig(rig, center(), this.magnification * (action === 'zoomIn' ? 1.25 : 0.8)),
        );
        break;
      case 'turnLeft':
      case 'turnRight':
        this.changeRig(
          turnRig(
            rig,
            center(),
            ((action === 'turnRight' ? 1 : -1) *
              useXRInput.getState().settings.turnAngle *
              Math.PI) /
              180,
          ),
        );
        break;
      case 'focusSelection': {
        const bounds = this.navigationBounds(true);
        if (!bounds.isEmpty()) this.changeRig(frameRig(this.head, bounds));
        break;
      }
      case 'previousView': {
        if (this.previousView) {
          const previous = this.previousView;
          this.previousView = this.worldView();
          this.rig = cloneRig(previous.rig);
          setXRSettings({ level: previous.level });
        }
        break;
      }
      case 'exit':
        exitXR();
        break;
    }
    // Hands holding the world start again from the new view.
    this.world = null;
  }

  private triangles(state: Editor, drawn = false) {
    let total = 0;
    for (const part of state.scene.parts)
      if (this.shown(part, state))
        total += triangleCount(
          drawn ? (partMeshes.get(part.id)?.geometry ?? part.geometry) : part.geometry,
        );
    return total;
  }

  private draw() {
    const rig = this.rig;
    const state = useEditor.getState();
    const head = new Vector3().setFromMatrixPosition(this.head);
    let hovered: PanelAction | null = null,
      pressed: PanelAction | null = null,
      holding: PartHold | null = null;
    const world: Pointer[] = [];
    for (const pointer of this.pointers.values()) {
      const { visual, action, hover } = pointer;
      if (!pointer.tracked) {
        visual.hide();
        pointer.highlight.hide();
        continue;
      }
      visual.showJoints(pointer.joints);
      const hand = pointer.hand.position,
        origin = pointer.origin();
      const over = hover?.kind === 'panel' ? hover.action : null;
      let tone: Tone = 'idle';
      let beam: { from: Vector3; to: Vector3; dot: boolean } | undefined;
      if (action?.kind === 'part') {
        holding = action;
        tone = 'hold';
        // A part held from a distance stays tied to the hand by the point it was taken by.
        if (!action.near)
          beam = {
            from: hand,
            to: hand
              .clone()
              .add(toRoom(rig, action.grab.pivot))
              .sub(toRoom(rig, action.grab.position)),
            dot: true,
          };
      } else if (action?.kind === 'world') {
        tone = 'world';
        world.push(pointer);
      } else if (action?.kind === 'panel') tone = 'hold';
      else if (hover?.kind === 'panel') {
        if (action?.kind === 'press' && over === action.action) pressed = over;
        else if (!action && over) hovered = over;
        tone = over ? 'hover' : 'idle';
        beam = { from: origin, to: hover.point, dot: true };
      } else if (hover?.kind === 'part') {
        tone = 'hover';
        beam = { from: hover.near ? hand : origin, to: toRoom(rig, hover.point), dot: true };
      } else if (!action)
        beam = {
          from: origin,
          to: origin.clone().addScaledVector(pointer.direction(), idleBeam),
          dot: false,
        };
      visual.show(hand, tone, beam);
      const aimed = !action && hover?.kind === 'part' ? partMeshes.get(hover.id) : undefined;
      if (aimed && triangleCount(aimed.geometry) <= highlightTriangles)
        pointer.highlight.show(aimed);
      else pointer.highlight.hide();
    }
    if (world.length === 2)
      this.readout.show(
        scaleLabel(magnification(rig)),
        world[0].hand.position
          .clone()
          .add(world[1].hand.position)
          .multiplyScalar(0.5)
          .setY(Math.max(world[0].hand.position.y, world[1].hand.position.y) + 0.05),
        head,
      );
    else if (this.navigating()) {
      const hand = this.worldStickOwner ?? world[0];
      if (hand)
        this.readout.show(
          scaleLabel(magnification(rig)),
          hand.hand.position.clone().add(new Vector3(0, 0.08, 0)),
          head,
        );
    } else this.readout.hide();

    const held = holding as PartHold | null;
    const selected = state.scene.parts.find((part) => part.id === state.selected[0]);
    this.wrist.hovered = null;
    this.wrist.pressed = null;
    for (const pointer of this.pointers.values()) {
      if (pointer.hover?.kind === 'panel' && pointer.hover.wrist) {
        this.wrist.hovered = pointer.hover.action;
        if (pointer.action?.kind === 'press') this.wrist.pressed = pointer.action.action;
      }
    }
    this.wrist.update(state.tool);
    this.panel.hovered = hovered;
    this.panel.pressed = pressed;
    this.panel.update({
      name: state.scene.name,
      canFocusSelection: !this.navigationBounds(true).isEmpty(),
      canRestoreView: !!this.previousView,
      canZoomIn: this.magnification < magnificationLimits.max - 1e-8,
      canZoomOut: this.magnification > magnificationLimits.min + 1e-8,
      tool: state.tool,
      toolStatus: this.navigating()
        ? `World navigation · ${scaleLabel(this.magnification)} · release to stop`
        : (state.toast?.message ?? xrToolStatus()),
      toolButtons: xrToolButtons(),
      precision: this.precision,
      multiSelect: this.multiSelect,
      axis: this.adjustmentAxis.toUpperCase(),
      inputSettings: useXRInput.getState().settings,
      hints: this.inputHints(),
      scale: scaleLabel(magnification(rig)),
      canUndo:
        canUndo(state) ||
        (state.tool === 'align' &&
          state.operation.mode === 'surface' &&
          state.paintHistory.length > 0),
      canRedo: canRedo(state),
      clip: state.view.clip.enabled,
      level: useXR.getState().settings.level,
      status: held
        ? `Holding ${held.start.length > 1 ? `${held.start.length} parts` : (held.start[0]?.name ?? 'a part')}${held.contact ? ' · held back' : ''}`
        : state.selected.length > 1
          ? `${state.selected.length} parts selected`
          : selected
            ? `Selected: ${selected.name}`
            : `${state.scene.parts.length} parts`,
      stats: this.stats.text,
    });
    const aimed =
      [...this.pointers.values()].find(
        (p) => p.tracked && p.source.handedness === useXRInput.getState().settings.dominantHand,
      ) ?? [...this.pointers.values()].find((p) => p.tracked);
    this.toolVisuals.update(
      state,
      rig.scale,
      aimed?.hover?.kind === 'part' ? aimed.hover.surface : undefined,
    );
  }

  /** Once a second, sums up how fast the headset is drawing, for the panel. */
  private measure(now: number) {
    const stats = this.stats;
    if (stats.last) {
      stats.frames++;
      stats.slowest = Math.max(stats.slowest, now - stats.last);
    } else stats.since = now;
    stats.last = now;
    if (now - stats.since < 1000) return;
    const rate = Math.round((stats.frames * 1000) / (now - stats.since));
    const state = useEditor.getState();
    const source = this.triangles(state),
      drawn = this.triangles(state, true);
    stats.text = [
      `${rate} fps`,
      `slowest ${stats.slowest.toFixed(0)} ms`,
      ...(stats.moves ? [`moving ${(stats.moving / stats.moves).toFixed(1)} ms`] : []),
      source === drawn
        ? `${count(source)} triangles`
        : `${count(drawn)} drawn / ${count(source)} source triangles`,
    ].join(' · ');
    Object.assign(stats, { since: now, frames: 0, slowest: 0, moving: 0, moves: 0 });
  }
}
