// Dense index builds belong off the render thread, including before the first grab in VR.
export const workerIndexTriangles = 100_000;
export const spatialIndexOptions = { indirect: true, targetLeafSize: 10 } as const;
