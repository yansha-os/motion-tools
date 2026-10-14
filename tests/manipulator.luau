local Manipulator = (function()
-- INSERT_MANIPULATOR_HERE
end)()

local projected = Manipulator.projectAxis(3, 4, 10)
assert(projected and math.abs(projected.x - 0.6) < 1e-9 and math.abs(projected.y - 0.8) < 1e-9)
assert(math.abs(projected.studsPerPixel - 2) < 1e-9)
assert(Manipulator.projectAxis(0, 0, 10) == nil)
assert(Manipulator.projectAxis(1, 1, 0) == nil)

local hit, perpendicular = Manipulator.moveHandleHit(35, 4, 1, 0, 5, 76, 11)
assert(hit and math.abs(perpendicular - 4) < 1e-9)
assert(not Manipulator.moveHandleHit(3, 0, 1, 0, 5, 76, 11))
assert(not Manipulator.moveHandleHit(35, 12, 1, 0, 5, 76, 11))
assert(not Manipulator.moveHandleHit(80, 0, 1, 0, 5, 76, 11))

assert(Manipulator.ringHandleHit(0, 32, 33, 2))
assert(not Manipulator.ringHandleHit(0, 25, 33, 2))
assert(math.abs(Manipulator.moveDelta(20, 50, 1, 0, 0.02) - 0.4) < 1e-9)
assert(math.abs(Manipulator.moveDelta(20, 50, 0, 1, 0.02) - 1) < 1e-9)

local quarterTurn = Manipulator.rotationDelta(10, 0, 0, 10, 0, 0)
assert(math.abs(quarterTurn - 90) < 1e-8)
local wrappedTurn = Manipulator.rotationDelta(-10, 1, -10, -1, 0, 0)
assert(math.abs(wrappedTurn - 11.4211862749993) < 1e-6)
print("Viewport gizmo axis projection, hit testing, translation and wrapped rotation passed")
