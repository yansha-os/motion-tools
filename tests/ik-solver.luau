local IKSolver = (function()
-- INSERT_IK_SOLVER_HERE
end)()

assert(IKSolver.isLimbJoint("RightHand", "RightHand"))
assert(IKSolver.isLimbJoint("Right Arm", "RightHand"))
assert(IKSolver.isLimbJoint("RightShoulder", "RightHand"))
assert(IKSolver.isLimbJoint("LeftUpperLeg", "LeftFoot"))
assert(IKSolver.isLimbJoint("LeftKnee", "LeftFoot"))
assert(not IKSolver.isLimbJoint("UpperTorso", "RightHand"))
assert(not IKSolver.isLimbJoint("RightHand", "LeftHand"))
assert(not IKSolver.isLimbJoint("RightFoot", "RightHand"))

local ax, ay, az, angle, distance = IKSolver.step(0, 0, 0, 1, 0, 0, 0, 1, 0)
assert(math.abs(ax) < 1e-9 and math.abs(ay) < 1e-9 and math.abs(az - 1) < 1e-9)
assert(math.abs(angle - math.pi / 2) < 1e-9 and math.abs(distance - 1) < 1e-9)

ax, ay, az, angle = IKSolver.step(2, 1, -3, 3, 1, -3, 2, 2, -3)
assert(math.abs(ax) < 1e-9 and math.abs(ay) < 1e-9 and math.abs(az - 1) < 1e-9)
assert(math.abs(angle - math.pi / 2) < 1e-9)

local poleX, poleY, poleZ, poleAngle = IKSolver.poleStep(0, 0, 0, 1, 1, 0, 0, 2, 0, 0, 0, 1)
assert(math.abs(poleX) < 1e-9 and math.abs(poleY - 1) < 1e-9 and math.abs(poleZ) < 1e-9)
assert(math.abs(poleAngle + math.pi / 2) < 1e-9, "Pole-vector correction should rotate the bend plane toward the requested pole")
local straightPoleX, straightPoleY, straightPoleZ, straightPoleAngle = IKSolver.poleStep(0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1)
assert(straightPoleX == nil and straightPoleY == nil and straightPoleZ == nil and straightPoleAngle == 0, "A straight limb has no stable current bend plane")
local axialPoleX, axialPoleY, axialPoleZ, axialPoleAngle = IKSolver.poleStep(0, 0, 0, 1, 1, 0, 0, 2, 0, 0, 4, 0)
assert(axialPoleX == nil and axialPoleY == nil and axialPoleZ == nil and axialPoleAngle == 0, "A pole target on the limb axis must not introduce an arbitrary bend")

ax, ay, az, angle = IKSolver.step(0, 0, 0, 1, 0, 0, -1, 0, 0)
assert(ax and ay and az and math.abs(math.sqrt(ax * ax + ay * ay + az * az) - 1) < 1e-9)
assert(math.abs(angle - math.pi) < 1e-9)

local zeroX, zeroY, zeroZ, zeroAngle, residual = IKSolver.step(1, 2, 3, 1, 2, 3, 4, 6, 3)
assert(zeroX == nil and zeroY == nil and zeroZ == nil and zeroAngle == 0 and math.abs(residual - 5) < 1e-9)
print("IK CCD and pole-vector solvers handle orthogonal, offset, opposite, straight, axial and zero-length cases")
