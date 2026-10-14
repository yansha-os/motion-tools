/** Roblox XYZ Euler rotation conversion shared by all animation authoring paths. */
export type Quaternion = [number, number, number, number];
export type EulerXYZDegrees = [number, number, number];

/** Convert Roblox XYZ Euler angles in degrees to a unit quaternion (qx * qy * qz). */
export function eulerXYZDegreesToQuaternion([xDegrees, yDegrees, zDegrees]: EulerXYZDegrees): Quaternion {
  const [x, y, z] = [xDegrees, yDegrees, zDegrees].map(value => value * Math.PI / 360);
  const cx = Math.cos(x!), sx = Math.sin(x!), cy = Math.cos(y!), sy = Math.sin(y!), cz = Math.cos(z!), sz = Math.sin(z!);
  return [sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz, cx * cy * cz - sx * sy * sz];
}

/** Convert a unit quaternion back to Roblox XYZ Euler angles in degrees. */
export function quaternionToEulerXYZDegrees([x, y, z, w]: Quaternion): EulerXYZDegrees {
  const roll = Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + y * y));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y + z * x))));
  const yaw = Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z));
  return [roll, pitch, yaw].map(value => {
    const degrees = Number((value * 180 / Math.PI).toFixed(12));
    return degrees === 0 ? 0 : degrees;
  }) as EulerXYZDegrees;
}
