import { BufferAttribute, BufferGeometry, Matrix4 } from 'three';
import { type CleanInput, type CleanResult, cleanSurface } from './refine-clean';
import { type DetectOptions, type RefineProposal, detectFeatures } from './refine-detect';
import { solveEdge } from './refine-edge';
import { estimateNoise, noiseRings } from './refine-fit';
import {
  type RefineMesh,
  type RefineTopology,
  buildRefineMesh,
  buildTopology,
  cloneRefineMesh,
  medianEdgeLength,
} from './refine-mesh';

export interface RefineModel {
  mesh: RefineMesh;
  topology: RefineTopology;
  noise: number;
  /** Median edge length, mm. */
  step: number;
}

export interface RefineModelInput {
  /** Decoded positions; Float64Array unless the source stores float32, so no bits are lost. */
  positions: Float32Array | Float64Array;
  index: Uint32Array | null;
  /** Decoded colours, `colorSize` per vertex. */
  color: Float32Array | null;
  colorSize: number;
  /** matrixWorld.elements */
  matrix: number[];
}

// The accessors buildRefineMesh decodes with, so half floats and normalized values read alike.
const getters = ['getX', 'getY', 'getZ', 'getW'] as const;

/** Copies of what buildRefineMesh reads from the geometry, so the buffers can be transferred. */
export function refineModelInput(geometry: BufferGeometry, matrixWorld: Matrix4): RefineModelInput {
  const position = geometry.getAttribute('position');
  const Positions = position.array instanceof Float32Array ? Float32Array : Float64Array;
  let positions: Float32Array | Float64Array = new Positions(position.count * 3);
  for (let v = 0; v < position.count; v++)
    for (let k = 0; k < 3; k++) {
      const value = position[getters[k]](v);
      const i = v * 3 + k;
      positions[i] = value;
      // An accessor may decode float32 storage to a value that needs a double.
      if (positions[i] !== value && value === value) {
        positions = Float64Array.from(positions);
        positions[i] = value;
      }
    }
  const source = geometry.getAttribute('color');
  const colorSize = source ? source.itemSize : 0;
  let color: Float32Array | null = null;
  if (source) {
    color = new Float32Array(source.count * colorSize);
    for (let v = 0; v < source.count; v++)
      for (let k = 0; k < colorSize; k++)
        color[v * colorSize + k] = k < 4 ? source[getters[k]](v) : source.getComponent(v, k);
  }
  return {
    positions,
    index: geometry.index ? Uint32Array.from(geometry.index.array) : null,
    color,
    colorSize,
    matrix: matrixWorld.elements.slice(),
  };
}

export function buildRefineModel(input: RefineModelInput): RefineModel {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(input.positions, 3));
  if (input.index) geometry.setIndex(new BufferAttribute(input.index, 1));
  if (input.color)
    geometry.setAttribute('color', new BufferAttribute(input.color, input.colorSize));
  const mesh = buildRefineMesh(geometry, new Matrix4().fromArray(input.matrix));
  const topology = buildTopology(mesh);
  const step = medianEdgeLength(mesh);
  return {
    mesh,
    topology,
    noise: estimateNoise(mesh, topology, undefined, noiseRings(step)),
    step,
  };
}

/** After a cut: rebuilds the topology and keeps the noise and step of `previous`. */
export function modelFromMesh(mesh: RefineMesh, previous: RefineModel): RefineModel {
  return { mesh, topology: buildTopology(mesh), noise: previous.noise, step: previous.step };
}

const cancelled = () => new DOMException('Refine cancelled', 'AbortError');

/**
 * Edge proposals that solveEdge can solve, with every region proposal, in order. Reports 0.7 to 1,
 * one step per proposal.
 */
export function keepSolvable(
  model: RefineModel,
  proposals: RefineProposal[],
  report: (fraction: number) => void,
  signal?: AbortSignal,
): RefineProposal[] {
  const kept: RefineProposal[] = [];
  proposals.forEach((proposal, i) => {
    if (signal?.aborted) throw cancelled();
    const { mesh, topology, noise } = model;
    if (proposal.type === 'region' || solveEdge(mesh, topology, proposal.input, noise))
      kept.push(proposal);
    report(i + 1 === proposals.length ? 1 : 0.7 + (0.3 * (i + 1)) / proposals.length);
  });
  if (!proposals.length) report(1);
  return kept;
}

export type RefineRequest =
  | { type: 'build'; input: RefineModelInput }
  | { type: 'detect'; model: RefineModel; options: DetectOptions }
  | { type: 'clean'; model: RefineModel; input: CleanInput };

/** The buffers of every typed array in `value`, for a transfer list. */
export function buffersOf(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const collect = (item: unknown) => {
    if (ArrayBuffer.isView(item)) {
      if (item.buffer instanceof ArrayBuffer) buffers.add(item.buffer);
    } else if (item && typeof item === 'object') Object.values(item).forEach(collect);
  };
  collect(value);
  return [...buffers];
}

/** A copy of the model's arrays, to post while the caller keeps its own. */
export function packRefineModel(model: RefineModel): RefineModel {
  const { topology } = model;
  return {
    ...model,
    mesh: cloneRefineMesh(model.mesh, true),
    topology: {
      triangleStart: topology.triangleStart.slice(),
      trianglesOf: topology.trianglesOf.slice(),
      neighbourStart: topology.neighbourStart.slice(),
      neighbours: topology.neighbours.slice(),
    },
  };
}

const arrayFields: [keyof RefineMesh, new (length: number) => ArrayBufferView][] = [
  ['position', Float64Array],
  ['weldOf', Uint32Array],
  ['corners', Uint32Array],
  ['touched', Uint8Array],
  ['crease', Uint8Array],
];

/** The model a message carried, checked to hold the array classes the Refine modules need. */
export function unpackRefineModel(value: unknown): RefineModel {
  const model = value as RefineModel;
  const valid =
    arrayFields.every(([key, Class]) => model?.mesh?.[key] instanceof Class) &&
    (model.mesh.color === null || model.mesh.color instanceof Float32Array) &&
    Object.values(model.topology ?? {}).every((array) => array instanceof Uint32Array) &&
    Object.keys(model.topology ?? {}).length === 4;
  if (!valid) throw new Error('The Refine model came back unreadable.');
  return model;
}

/** The proposals a message carried. */
export function unpackProposals(value: unknown): RefineProposal[] {
  if (!Array.isArray(value)) throw new Error('The Refine proposals came back unreadable.');
  return value as RefineProposal[];
}

/** The cleaned positions a message carried. */
export function unpackClean(value: unknown): CleanResult {
  const result = value as CleanResult;
  if (
    !(result?.moved instanceof Uint32Array) ||
    !(result.position instanceof Float64Array) ||
    result.position.length !== result.moved.length * 3
  )
    throw new Error('The cleaned surface came back unreadable.');
  return result;
}

/** Runs a request as the worker does, both in the worker and in-thread. */
export function runRefineRequest(
  request: RefineRequest,
  report: (fraction: number) => void,
  signal?: AbortSignal,
): RefineModel | RefineProposal[] | CleanResult {
  if (request.type === 'build') return buildRefineModel(request.input);
  const model = unpackRefineModel(request.model);
  if (request.type === 'clean')
    return cleanSurface(
      model.mesh,
      model.topology,
      model.noise,
      model.step,
      request.input,
      report,
      signal,
    );
  const { mesh, topology, noise } = model;
  const found = detectFeatures(
    mesh,
    topology,
    noise,
    request.options,
    (f) => report(0.7 * f),
    signal,
  );
  return keepSolvable(model, found, report, signal);
}
