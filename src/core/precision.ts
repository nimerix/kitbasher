import { Matrix4, Quaternion, Vector3 } from 'three';

/** Accumulate incremental raw gizmo motion, so changing gain never rebases a drag. */
export class PrecisionDrag {
  private inverse: Matrix4;
  private rawPosition = new Vector3();
  private rawRotation = new Quaternion();
  private rawScale = new Vector3();
  private position = new Vector3();
  private rotation = new Quaternion();
  private scale = new Vector3();

  constructor(matrix: Matrix4) {
    this.inverse = matrix.clone().invert();
    matrix.decompose(this.rawPosition, this.rawRotation, this.rawScale);
    this.position.copy(this.rawPosition);
    this.rotation.copy(this.rawRotation);
    this.scale.copy(this.rawScale);
  }

  update(matrix: Matrix4, gain: number) {
    const position = new Vector3(),
      rotation = new Quaternion(),
      scale = new Vector3();
    matrix.decompose(position, rotation, scale);
    if (!matrix.elements.every(Number.isFinite) || Math.min(scale.x, scale.y, scale.z) <= 0)
      return null;
    this.position.add(position.clone().sub(this.rawPosition).multiplyScalar(gain));
    const delta = rotation.clone().multiply(this.rawRotation.clone().invert());
    this.rotation.premultiply(new Quaternion().slerp(delta, gain)).normalize();
    const ratio = scale.clone().divide(this.rawScale);
    this.scale.multiply(new Vector3(ratio.x ** gain, ratio.y ** gain, ratio.z ** gain));
    this.rawPosition.copy(position);
    this.rawRotation.copy(rotation);
    this.rawScale.copy(scale);
    return new Matrix4().compose(this.position, this.rotation, this.scale).multiply(this.inverse);
  }
}
