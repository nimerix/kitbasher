import { useEffect, useMemo } from 'react';
import { Html } from '@react-three/drei';
import { DoubleSide, Quaternion, Vector3 } from 'three';
import { useEditor } from '../core/store';
import { contactColors, patchCenter, patchGeometry } from '../core/surfaces';
import { worldNormal, worldPoint } from '../core/geometry';
import type { Part, SurfacePatch, SurfacePoint } from '../core/types';

function PaintedPatch({
  part,
  patch,
  color,
  label,
}: {
  part: Part;
  patch: SurfacePatch;
  color: string;
  label: string;
}) {
  const geometry = useMemo(
    () => patchGeometry(part.geometry, patch.faces),
    [part.geometry, patch.faces],
  );
  const center = useMemo(() => patchCenter(part, patch), [part, patch]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  if (!part.visible || !patch.faces.length) return null;
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
      {center ? (
        <Html position={center} center style={{ pointerEvents: 'none' }}>
          <span className="surface-pick-label" style={{ color }}>
            {label}
          </span>
        </Html>
      ) : null}
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
              label={`${side === 'source' ? 'S' : 'T'}${index + 1}`}
            />
          ) : null;
        }),
      )}
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
