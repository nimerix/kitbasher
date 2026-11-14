/** Runs inside a fresh documentation browser, via page.evaluate or a preview tab. */
export async function preparePinCapture(kind) {
  const { useEditor } = await import('/src/core/store.ts');
  const { createSample } = await import('/src/core/sample.ts');
  const { pinGaps } = await import('/src/core/pins.ts');
  const editor = useEditor.getState();
  editor.setScene(createSample());
  editor.select('torso');
  editor.isolate(['torso']);
  editor.setView({
    projection: 'orthographic',
    clip: { enabled: false, overlap: 0.1 },
  });
  editor.setTool('pins');
  useEditor.setState({ pinPicking: kind });
  const points =
    kind === 'hard'
      ? [[-9, -4, 11.7]]
      : [
          [-9, 0, 11.7],
          [9, 0, 11.7],
        ];
  for (const point of points) editor.addPin({ partId: 'torso', point, normal: [0, 0, 1] });
  const pins = useEditor.getState().scene.parts.find((part) => part.id === 'torso').pins;
  if (kind === 'soft') {
    editor.updatePin('torso', pins[0].id, { priority: 85 });
    editor.updatePin('torso', pins[1].id, { priority: 15 });
  }
  useEditor.setState({ pinPicking: null, activePin: pins.at(-1).id });
  const halfAngle = kind === 'hard' ? 0.25 : 0.4;
  editor.transform('torso', { quaternion: [0, 0, Math.sin(halfAngle), Math.cos(halfAngle)] });
  editor.focus('front');
  return pinGaps(useEditor.getState().scene.parts.find((part) => part.id === 'torso'));
}
