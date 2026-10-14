local math = table.clone(math)
math.clamp = function(value, minimum, maximum) return math.max(minimum, math.min(maximum, value)) end
-- INSERT_MIRROR_HERE

local function near(actual, expected, epsilon, message)
    assert(math.abs(actual - expected) <= (epsilon or 1e-6), string.format("%s: expected %.8f, got %.8f", message, expected, actual))
end
local function quaternionMatrix(q)
    local x, y, z, w = q[1], q[2], q[3], q[4]
    return {
        {1 - 2 * (y*y + z*z), 2 * (x*y - z*w), 2 * (x*z + y*w)},
        {2 * (x*y + z*w), 1 - 2 * (x*x + z*z), 2 * (y*z - x*w)},
        {2 * (x*z - y*w), 2 * (y*z + x*w), 1 - 2 * (x*x + y*y)},
    }
end
local function xyzMatrix(degrees)
    local x, y, z = math.rad(degrees[1]), math.rad(degrees[2]), math.rad(degrees[3])
    local sx, cx, sy, cy, sz, cz = math.sin(x), math.cos(x), math.sin(y), math.cos(y), math.sin(z), math.cos(z)
    return {
        {cy * cz, -cy * sz, sy},
        {sx * sy * cz + cx * sz, cx * cz - sx * sy * sz, -sx * cy},
        {sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy},
    }
end
local function multiplyMatrix(left, right)
    local result = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}}
    for row = 1, 3 do for column = 1, 3 do
        for inner = 1, 3 do result[row][column] += left[row][inner] * right[inner][column] end
    end end
    return result
end
local function transpose(matrix)
    return {{matrix[1][1], matrix[2][1], matrix[3][1]}, {matrix[1][2], matrix[2][2], matrix[3][2]}, {matrix[1][3], matrix[2][3], matrix[3][3]}}
end
local function multiplyVector(matrix, value)
    return {
        matrix[1][1] * value[1] + matrix[1][2] * value[2] + matrix[1][3] * value[3],
        matrix[2][1] * value[1] + matrix[2][2] * value[2] + matrix[2][3] * value[3],
        matrix[3][1] * value[1] + matrix[3][2] * value[2] + matrix[3][3] * value[3],
    }
end
local identity = { 0, 0, 0, 1 }
local position, rotation = Mirror.pose({ 1, 2, 3 }, { 12, 35, -42 }, identity, identity)
near(position[1], -1, 1e-8, "identity-basis X reflection")
near(position[2], 2, 1e-8, "identity-basis Y preservation")
near(position[3], 3, 1e-8, "identity-basis Z preservation")
near(rotation[1], 12, 1e-6, "identity-basis X rotation")
near(rotation[2], -35, 1e-6, "identity-basis Y reflection")
near(rotation[3], 42, 1e-6, "identity-basis Z reflection")

local half = math.sqrt(0.5)
local sourceBasis = { 0, 0, half, half }
position, rotation = Mirror.pose({ 1, 2, 3 }, { 0, 0, 0 }, sourceBasis, identity)
near(position[1], 2, 1e-8, "custom source basis reflected X")
near(position[2], 1, 1e-8, "custom source basis reflected Y")
near(position[3], 3, 1e-8, "custom source basis reflected Z")
near(rotation[1], 0, 1e-6, "custom basis rotation X")
near(rotation[2], 0, 1e-6, "custom basis rotation Y")
near(rotation[3], -90, 1e-6, "custom basis maps into target rest orientation")

local targetBasis = { 0, 0, -half, half }
position, rotation = Mirror.pose({ 1, 2, 3 }, { 0, 0, 0 }, sourceBasis, targetBasis)
near(position[1], -1, 1e-8, "both custom bases X")
near(position[2], 2, 1e-8, "both custom bases Y")
near(position[3], 3, 1e-8, "both custom bases Z")
near(rotation[3], 0, 1e-6, "symmetric custom bases produce neutral local rotation")

local arbitrarySourceBasis = { math.sin(math.rad(20) / 2), 0, math.sin(math.rad(35) / 2), math.cos(math.rad(20) / 2) * math.cos(math.rad(35) / 2) }
-- Normalize the independent fixture quaternion after combining two axis rotations.
local arbitraryMagnitude = math.sqrt(arbitrarySourceBasis[1]^2 + arbitrarySourceBasis[3]^2 + arbitrarySourceBasis[4]^2)
for index = 1, 4 do arbitrarySourceBasis[index] /= arbitraryMagnitude end
local arbitraryTargetBasis = { 0, math.sin(math.rad(27) / 2), -math.sin(math.rad(18) / 2), math.cos(math.rad(27) / 2) * math.cos(math.rad(18) / 2) }
local targetMagnitude = math.sqrt(arbitraryTargetBasis[2]^2 + arbitraryTargetBasis[3]^2 + arbitraryTargetBasis[4]^2)
for index = 1, 4 do arbitraryTargetBasis[index] /= targetMagnitude end
local inputPosition, inputRotation = {0.7, -1.25, 2.4}, {23, -37, 51}
local arbitraryPosition, arbitraryRotation = Mirror.pose(inputPosition, inputRotation, arbitrarySourceBasis, arbitraryTargetBasis)
local sourceMatrix = quaternionMatrix(arbitrarySourceBasis)
local targetMatrix = quaternionMatrix(arbitraryTargetBasis)
local reflection = {{-1, 0, 0}, {0, 1, 0}, {0, 0, 1}}
local expectedPosition = multiplyVector(transpose(targetMatrix), multiplyVector(reflection, multiplyVector(sourceMatrix, inputPosition)))
local expectedWorldRotation = multiplyMatrix(reflection, multiplyMatrix(sourceMatrix, xyzMatrix(inputRotation)))
expectedWorldRotation = multiplyMatrix(expectedWorldRotation, reflection)
local expectedTargetRotation = multiplyMatrix(transpose(targetMatrix), expectedWorldRotation)
local actualTargetRotation = xyzMatrix(arbitraryRotation)
for axis = 1, 3 do
    near(arbitraryPosition[axis], expectedPosition[axis], 1e-8, "arbitrary custom-basis reflected position")
    for column = 1, 3 do
        near(actualTargetRotation[axis][column], expectedTargetRotation[axis][column], 1e-6,
            "arbitrary custom-basis reflected orientation matrix")
    end
end
local roundTripPosition, roundTripRotation = Mirror.pose(arbitraryPosition, arbitraryRotation, arbitraryTargetBasis, arbitrarySourceBasis)
for axis = 1, 3 do near(roundTripPosition[axis], inputPosition[axis], 1e-8, "mirror twice restores position") end
local roundTripMatrix, originalMatrix = xyzMatrix(roundTripRotation), xyzMatrix(inputRotation)
for row = 1, 3 do for column = 1, 3 do
    near(roundTripMatrix[row][column], originalMatrix[row][column], 1e-6, "mirror twice restores orientation")
end end

local ok = pcall(Mirror.pose, { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0, 0 }, identity)
assert(not ok, "invalid zero rest-basis quaternion must fail closed")
ok = pcall(Mirror.pose, { 0, 0, 0 }, { 0, 0, math.huge }, identity, identity)
assert(not ok, "non-finite pose values must fail closed")
print("Rig-aware mirror handles identity and custom rest bases, and rejects invalid transforms")
