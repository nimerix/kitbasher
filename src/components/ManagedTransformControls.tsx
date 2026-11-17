import { useEffect, useRef } from 'react';
import type { ComponentProps } from 'react';
import type { TransformControls as TransformControlsImpl } from 'three-stdlib';
import { useThree } from '@react-three/fiber';
import { TransformControls } from '@react-three/drei';

/** Transform controls that end their drag on mouse up and when they are torn down. */
export function ManagedTransformControls({
  onFinishDrag,
  ...props
}: ComponentProps<typeof TransformControls> & { onFinishDrag: () => void }) {
  const controls = useRef<TransformControlsImpl>(null);
  const gl = useThree((s) => s.gl);
  const connected = useThree((s) => s.events.connected);
  useEffect(() => {
    const current = controls.current;
    current?.connect(connected instanceof HTMLElement ? connected : gl.domElement);
    return () => {
      // The controls keep document-level pointer listeners while dragging.
      current?.dispose();
      onFinishDrag();
    };
  }, [onFinishDrag, gl.domElement, connected]);
  return <TransformControls ref={controls} {...props} onMouseUp={onFinishDrag} />;
}
