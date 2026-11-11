import { useEffect, useMemo } from 'react';
import { DoubleSide, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import { useEditor } from '../core/store';
import { contactColors, patchGeometry } from '../core/surfaces';
import { worldNormal, worldPoint } from '../core/geometry';
import { solveAlignment } from '../core/alignment';
import { hiddenByIsolation } from '../core/isolation';
import type { Part, SurfacePatch, SurfacePoint } from '../core/types';

/** The patch's S/T label is drawn by the annotation layer. */
function PaintedPatch({ part, patch, color }: { part: Part; patch: SurfacePatch; color: string }) {
  const geometry = useMemo(
    () => patchGeometry(part.geometry, patch.faces),
    [part.geometry, patch.faces],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  const hidden = useEditor((s) => hiddenByIsolation(s.isolated, s.nearbyParts, part.id));
  if (!part.visible || hidden || !patch.faces.length) return null;
  return (
    <group position={part.position} quaternion={part.quaternion} scale={part.scale}>
      <mesh geometry={geometry} raycast={() => {}} renderOrder={5}>
        <meshBasicMaterial
          color={color}
          side={DoubleSide}
          transparent
          opacity={0.65}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-3}
          polygonOffsetUnits={-3}
        />
      </mesh>
    </group>
  );
}

export function SurfacePaintOverlay() {
  const pairs = useEditor((s) => s.operation.surfacePairs),
    parts = useEditor((s) => s.scene.parts),
    visible = useEditor(
      (s) => s.tool === 'align' && s.operation.mode === 'surface' && !s.view.explode,
    );
  if (!visible) return null;
  return (
    <>
      <FlushPreview />
      {pairs.flatMap((pair, index) =>
        (['source', 'target'] as const).map((side) => {
          const patch = pair[side],
            part = parts.find((part) => part.id === patch?.partId);
          return patch && part ? (
            <PaintedPatch
              key={`${pair.id}-${side}`}
              part={part}
              patch={patch}
              color={contactColors[index % contactColors.length]}
            />
          ) : null;
        }),
      )}
    </>
  );
}

function FlushPreview() {
  const material = useMemo(
    () =>
      new MeshBasicMaterial({
        color: '#63e5ec',
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        side: DoubleSide,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);
  const scene = useEditor((state) => state.scene),
    operation = useEditor((state) => state.operation),
    painting = useEditor((state) => state.painting),
    clip = useEditor((state) => state.view.clip);
  const parts = useMemo(() => {
    if (painting || operation.surfaceMethod !== 'flush') return [];
    try {
      return solveAlignment(scene, operation, clip).parts.filter((part) => {
        const original = scene.parts.find((entry) => entry.id === part.id)!;
        return (
          part.visible &&
          [...part.position, ...part.quaternion].some(
            (value, index) =>
              Math.abs(value - [...original.position, ...original.quaternion][index]) > 1e-6,
          )
        );
      });
    } catch {
      return [];
    }
  }, [scene, operation, painting, clip]);
  return (
    <>
      {parts.map((part) => (
        <mesh
          key={part.id}
          name={`flush-preview:${part.id}`}
          geometry={part.geometry}
          material={material}
          position={part.position}
          quaternion={part.quaternion}
          scale={part.scale}
          raycast={() => {}}
          renderOrder={4}
          dispose={null}
        />
      ))}
    </>
  );
}

export function PaintCursor({ part, hit }: { part: Part; hit: SurfacePoint | null }) {
  const radius = useEditor((s) => s.brushRadius),
    erase = useEditor((s) => s.brushErase),
    op = useEditor((s) => s.operation),
    tool = useEditor((s) => s.tool),
    navigationMode = useEditor((s) => (s.temporaryOrbit ? 'orbit' : s.navigationMode)),
    pivotPicking = useEditor((s) => s.pivotPicking);
  if (
    !hit ||
    tool !== 'align' ||
    op.mode !== 'surface' ||
    navigationMode ||
    pivotPicking ||
    !op.activeSurface
  )
    return null;
  const index = op.surfacePairs.findIndex((pair) => pair.id === op.activeSurface?.pairId);
  const normal = worldNormal(part, hit),
    position = worldPoint(part, hit).addScaledVector(normal, 0.03);
  const rotation = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), normal);
  return (
    <group position={position} quaternion={rotation}>
      <mesh raycast={() => {}} renderOrder={20}>
        <ringGeometry args={[radius, radius + Math.max(radius * 0.025, 0.035), 64]} />
        <meshBasicMaterial
          color={erase ? '#f18c8c' : contactColors[index % contactColors.length]}
          side={DoubleSide}
          depthTest={false}
          transparent
          opacity={0.9}
        />
      </mesh>
    </group>
  );
}
