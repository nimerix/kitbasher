import { Group, Matrix4, Quaternion, Raycaster, Triangle, Vector3 } from 'three';
import type { Camera, Mesh, Scene, WebGLRenderer } from 'three';
import { treeOf } from '../core/clipping';
import { sceneBounds, triangleCount } from '../core/geometry';
import { hiddenByIsolation } from '../core/isolation';
import { canRedo, canUndo, useEditor } from '../core/store';
import { readFace } from '../core/surfaces';
import type { Part, Quat, Vec3 } from '../core/types';
import {
  cloneRig,
  dragRig,
  frameRig,
  heldPose,
  levelRig,
  magnification,
  pinchRig,
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

type Hover =
  | { kind: 'panel'; action: PanelAction | null; point: Vector3 }
  | { kind: 'part'; id: string; point: Vector3; near: boolean };

interface PartHold {
  kind: 'part';
  by: Trigger;
  start: Part[];
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
  | { kind: 'press'; by: Trigger; action: PanelAction }
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
  summoning = false;
  constructor(readonly source: XRInputSource) {}

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
  /** The head, in the room. Standing height until the headset reports where it is. */
  readonly head = new Matrix4().makeTranslation(0, 1.6, 0);
  rig: Rig;
  /** Set once the headset has said where the viewer is, and the model is placed before them. */
  placed = false;
  private readonly pointers = new Map<XRInputSource, Pointer>();
  private readonly readout = new Readout();
  private readonly raycaster = new Raycaster();
  private readonly triangle = new Triangle();
  private readonly inverse = new Matrix4();
  private world: { key: string; rig: Rig; hands: Vector3[] } | null = null;
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
    this.rig = frameRig(this.head, sceneBounds(useEditor.getState().scene.parts));
    this.applyRig();
    this.root.add(this.panel.object, this.readout.object);
    this.panel.object.visible = false;
    scene.add(this.root);
    const queue = (trigger: Trigger, down: boolean) => (event: XRInputSourceEvent) =>
      this.pointerFor(event.inputSource).events.push({ trigger, down });
    const listeners = {
      selectstart: queue('select', true),
      selectend: queue('select', false),
      squeezestart: queue('squeeze', true),
      squeezeend: queue('squeeze', false),
    };
    for (const [type, listener] of Object.entries(listeners))
      session.addEventListener(type as 'selectstart', listener);
    this.stop = () => {
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
    this.readout.dispose();
  }

  update(frame: XRFrame | undefined) {
    const space = this.gl.xr.getReferenceSpace();
    const viewer = frame && space ? frame.getViewerPose(space) : null;
    if (!frame || !space || !viewer) return;
    this.head.fromArray(viewer.transform.matrix);
    const state = useEditor.getState();
    if (!this.placed) {
      this.placed = true;
      this.rig = frameRig(this.head, sceneBounds(state.scene.parts));
      this.panel.place(this.head);
      this.panel.object.visible = true;
    }
    if (state.scene.parts !== this.parts) {
      const before = new Set(this.parts.map((part) => part.id));
      this.parts = state.scene.parts;
      // A different scene, or the first parts of an empty one, is set before the viewer afresh.
      if (this.parts.length && !this.parts.some((part) => before.has(part.id))) {
        this.rig = frameRig(this.head, sceneBounds(this.parts));
        this.world = null;
      }
    }
    this.track(frame, space);
    this.moveWorld();
    this.applyRig();
    for (const pointer of this.pointers.values()) {
      this.point(pointer, state);
      for (const event of pointer.events.splice(0))
        if (event.down) this.press(pointer, event.trigger);
        else this.letGo(pointer, event.trigger);
    }
    for (const pointer of this.pointers.values()) this.hold(pointer);
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
    this.root.remove(pointer.visual.object);
    this.scene.remove(pointer.highlight.object);
    pointer.visual.dispose();
    pointer.highlight.dispose();
    this.pointers.delete(pointer.source);
  }

  private track(frame: XRFrame, space: XRReferenceSpace) {
    const present = new Set<XRInputSource>();
    for (const source of this.session.inputSources) {
      if (source.targetRayMode !== 'tracked-pointer') continue;
      present.add(source);
      const pointer = this.pointerFor(source);
      const aim = frame.getPose(source.targetRaySpace, space);
      pointer.tracked = !!aim;
      if (!aim) continue;
      pointer.aim.fromArray(aim.transform.matrix);
      pointer.hand.position.setFromMatrixPosition(pointer.aim);
      pointer.hand.quaternion.setFromRotationMatrix(pointer.aim);
      pointer.joints.length = 0;
      if (source.hand) this.trackHand(frame, space, source.hand, pointer);
      // B or Y brings the panel back in front of the viewer.
      const summoning = !!source.gamepad?.buttons[5]?.pressed;
      if (summoning && !pointer.summoning) this.panel.place(this.head);
      pointer.summoning = summoning;
    }
    for (const [source, pointer] of [...this.pointers])
      if (!present.has(source)) this.drop(pointer);
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
    if (thumb && index) pointer.hand.position.copy(thumb).add(index).multiplyScalar(0.5);
  }

  /** Hands holding the world carry it, and two of them also resize and turn it. */
  private moveWorld() {
    const hands = [...this.pointers.values()]
      .filter((pointer) => pointer.tracked && pointer.action?.kind === 'world')
      .slice(0, 2);
    const key = hands.map((pointer) => [...this.pointers.values()].indexOf(pointer)).join();
    if (!hands.length) {
      this.world = null;
      return;
    }
    // Each time a hand joins or leaves, the others start again from where they are.
    if (this.world?.key !== key) {
      this.world = {
        key,
        rig: cloneRig(this.rig),
        hands: hands.map((pointer) => pointer.hand.position.clone()),
      };
      return;
    }
    const [from, other] = this.world.hands;
    this.rig =
      hands.length === 1
        ? dragRig(this.world.rig, from, hands[0].hand.position)
        : pinchRig(
            this.world.rig,
            [from, other],
            [hands[0].hand.position, hands[1].hand.position],
            useXR.getState().settings.level,
          );
  }

  private shown(part: Part, state: Editor) {
    return part.visible && !hiddenByIsolation(state.isolated, state.nearbyParts, part.id);
  }

  /** What a press would act on: a part within touch, the panel, or a part pointed at. */
  private point(pointer: Pointer, state: Editor) {
    pointer.hover = null;
    const action = pointer.action;
    if (!pointer.tracked || (action && action.kind !== 'press')) return;
    const origin = pointer.origin(),
      direction = pointer.direction();
    const panel = this.panel.hit(origin, direction);
    // A press only needs to know whether it is still over its button.
    if (action) {
      if (panel) pointer.hover = { kind: 'panel', action: panel.action, point: panel.point };
      return;
    }
    // A part in the hand comes first. The panel is drawn over everything, so it comes next.
    pointer.hover =
      this.touch(pointer, state) ??
      (panel ? { kind: 'panel', action: panel.action, point: panel.point } : null) ??
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
      const tree = mesh && this.shown(part, state) ? treeOf(part.geometry) : null;
      if (!mesh || !tree) continue;
      if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
      const box = part.geometry.boundingBox!;
      const elements = mesh.matrixWorld.elements;
      const stretch = [0, 4, 8].map((i) =>
        Math.hypot(elements[i], elements[i + 1], elements[i + 2]),
      );
      const smallest = Math.min(...stretch);
      local.copy(hand).applyMatrix4(this.inverse.copy(mesh.matrixWorld).invert());
      if (!(smallest > 0) || box.distanceToPoint(local) * smallest > reach) continue;
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
    if (pointer.action || !pointer.tracked) return;
    const hover = pointer.hover;
    if (by === 'select' && hover?.kind === 'panel') {
      pointer.action = hover.action
        ? { kind: 'press', by, action: hover.action }
        : {
            kind: 'panel',
            by,
            offset: pointer.matrix().invert().multiply(this.panel.object.matrix),
          };
      return;
    }
    if (by === 'select' && hover?.kind === 'part' && this.take(pointer, hover, by)) return;
    // Empty space, the grip, and parts that are locked in place all hold the world itself.
    pointer.action = { kind: 'world', by };
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
    else if (
      action.kind === 'press' &&
      pointer.hover?.kind === 'panel' &&
      pointer.hover.action === action.action
    )
      this.run(action.action);
  }

  private hold(pointer: Pointer) {
    const action = pointer.action;
    if (!action || !pointer.tracked) return;
    if (action.kind === 'part') this.carry(pointer, action);
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
    const hand = this.sceneHand(pointer);
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
    state.transformMany(action.patches, false, true, true);
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

  private run(action: PanelAction) {
    const state = useEditor.getState();
    const center = () => sceneBounds(state.scene.parts).getCenter(new Vector3());
    const rig = this.rig;
    switch (action) {
      case 'undo':
      case 'redo':
        // A part still in the other hand would be put straight back.
        for (const pointer of this.pointers.values())
          if (pointer.action?.kind === 'part') pointer.action = null;
        state[action]();
        break;
      case 'clip':
        state.setView({ clip: { ...state.view.clip, enabled: !state.view.clip.enabled } });
        break;
      case 'level': {
        const level = !useXR.getState().settings.level;
        setXRSettings({ level });
        if (level) this.rig = levelRig(rig, center());
        break;
      }
      case 'trueSize':
        this.rig = rescaleRig(rig, center(), 1);
        break;
      case 'reset':
        this.rig = frameRig(this.head, sceneBounds(state.scene.parts));
        break;
      case 'exit':
        exitXR();
        break;
    }
    // Hands holding the world start again from the new view.
    this.world = null;
  }

  private triangles(state: Editor) {
    let total = 0;
    for (const part of state.scene.parts)
      if (this.shown(part, state)) total += triangleCount(part.geometry);
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
    else this.readout.hide();

    const held = holding as PartHold | null;
    const selected = state.scene.parts.find((part) => part.id === state.selected[0]);
    this.panel.hovered = hovered;
    this.panel.pressed = pressed;
    this.panel.update({
      name: state.scene.name,
      scale: scaleLabel(magnification(rig)),
      canUndo: canUndo(state),
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
    stats.text = [
      `${rate} fps`,
      `slowest ${stats.slowest.toFixed(0)} ms`,
      ...(stats.moves ? [`moving ${(stats.moving / stats.moves).toFixed(1)} ms`] : []),
      `${count(this.triangles(useEditor.getState()))} triangles`,
    ].join(' · ');
    Object.assign(stats, { since: now, frames: 0, slowest: 0, moving: 0, moves: 0 });
  }
}
