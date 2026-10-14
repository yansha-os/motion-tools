local Mirror = {}

local function finite(value)
    return type(value) == "number" and value == value and math.abs(value) < math.huge
end

local function normalizeQuaternion(value, name)
    assert(type(value) == "table" and #value == 4, name .. " must be a four-component quaternion.")
    for _, component in ipairs(value) do assert(finite(component), name .. " contains a non-finite component.") end
    local magnitude = math.sqrt(value[1] * value[1] + value[2] * value[2] + value[3] * value[3] + value[4] * value[4])
    assert(magnitude > 1e-12, name .. " cannot be a zero quaternion.")
    return { value[1] / magnitude, value[2] / magnitude, value[3] / magnitude, value[4] / magnitude }
end

local function multiply(left, right)
    local x1, y1, z1, w1 = left[1], left[2], left[3], left[4]
    local x2, y2, z2, w2 = right[1], right[2], right[3], right[4]
    return {
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
    }
end

local function inverse(value)
    return { -value[1], -value[2], -value[3], value[4] }
end

local function quaternionToMatrix(value)
    local x, y, z, w = value[1], value[2], value[3], value[4]
    local xx, yy, zz = x * x, y * y, z * z
    local xy, xz, yz = x * y, x * z, y * z
    local wx, wy, wz = w * x, w * y, w * z
    return {
        { 1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy) },
        { 2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx) },
        { 2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy) },
    }
end

local function matrixToQuaternion(matrix)
    local m11, m12, m13 = matrix[1][1], matrix[1][2], matrix[1][3]
    local m21, m22, m23 = matrix[2][1], matrix[2][2], matrix[2][3]
    local m31, m32, m33 = matrix[3][1], matrix[3][2], matrix[3][3]
    local trace = m11 + m22 + m33
    local x, y, z, w
    if trace > 0 then
        local s = math.sqrt(math.max(0, trace + 1)) * 2
        w, x, y, z = s / 4, (m32 - m23) / s, (m13 - m31) / s, (m21 - m12) / s
    elseif m11 > m22 and m11 > m33 then
        local s = math.sqrt(math.max(0, 1 + m11 - m22 - m33)) * 2
        w, x, y, z = (m32 - m23) / s, s / 4, (m12 + m21) / s, (m13 + m31) / s
    elseif m22 > m33 then
        local s = math.sqrt(math.max(0, 1 + m22 - m11 - m33)) * 2
        w, x, y, z = (m13 - m31) / s, (m12 + m21) / s, s / 4, (m23 + m32) / s
    else
        local s = math.sqrt(math.max(0, 1 + m33 - m11 - m22)) * 2
        w, x, y, z = (m21 - m12) / s, (m13 + m31) / s, (m23 + m32) / s, s / 4
    end
    return normalizeQuaternion({ x, y, z, w }, "Mirrored rotation")
end

local function eulerXYZToQuaternion(rotation)
    assert(type(rotation) == "table" and #rotation == 3, "Pose rotation must have three components.")
    for _, angle in ipairs(rotation) do assert(finite(angle), "Pose rotation must be finite.") end
    local x, y, z = math.rad(rotation[1]) / 2, math.rad(rotation[2]) / 2, math.rad(rotation[3]) / 2
    local cx, sx, cy, sy, cz, sz = math.cos(x), math.sin(x), math.cos(y), math.sin(y), math.cos(z), math.sin(z)
    return normalizeQuaternion({
        sx * cy * cz + cx * sy * sz,
        cx * sy * cz - sx * cy * sz,
        cx * cy * sz + sx * sy * cz,
        cx * cy * cz - sx * sy * sz,
    }, "Pose rotation")
end

local function quaternionToEulerXYZ(value)
    local matrix = quaternionToMatrix(value)
    local y = math.asin(math.clamp(matrix[1][3], -1, 1))
    local x, z
    if math.abs(math.cos(y)) > 1e-8 then
        x = math.atan2(-matrix[2][3], matrix[3][3])
        z = math.atan2(-matrix[1][2], matrix[1][1])
    else
        x = math.atan2(matrix[3][2], matrix[2][2])
        z = 0
    end
    return { math.deg(x), math.deg(y), math.deg(z) }
end

local function rotateVector(rotation, vector)
    local matrix = quaternionToMatrix(rotation)
    return {
        matrix[1][1] * vector[1] + matrix[1][2] * vector[2] + matrix[1][3] * vector[3],
        matrix[2][1] * vector[1] + matrix[2][2] * vector[2] + matrix[2][3] * vector[3],
        matrix[3][1] * vector[1] + matrix[3][2] * vector[2] + matrix[3][3] * vector[3],
    }
end

local function reflectX(vector)
    return { -vector[1], vector[2], vector[3] }
end

local function reflectRotationX(value)
    local matrix = quaternionToMatrix(value)
    for row = 1, 3 do
        for column = 1, 3 do
            local rowSign = row == 1 and -1 or 1
            local columnSign = column == 1 and -1 or 1
            matrix[row][column] *= rowSign * columnSign
        end
    end
    return matrixToQuaternion(matrix)
end

function Mirror.pose(position, rotationDegrees, sourceBasisInput, targetBasisInput)
    assert(type(position) == "table" and #position == 3, "Pose position must have three components.")
    for _, component in ipairs(position) do assert(finite(component), "Pose position must be finite.") end
    local sourceBasis = normalizeQuaternion(sourceBasisInput, "Source rig basis")
    local targetBasis = normalizeQuaternion(targetBasisInput, "Target rig basis")
    local sourceRotation = eulerXYZToQuaternion(rotationDegrees)

    local sourceOffsetInRigSpace = rotateVector(sourceBasis, position)
    local reflectedOffset = reflectX(sourceOffsetInRigSpace)
    local mirroredPosition = rotateVector(inverse(targetBasis), reflectedOffset)

    local sourceWorldRotation = multiply(sourceBasis, sourceRotation)
    local reflectedWorldRotation = reflectRotationX(sourceWorldRotation)
    local targetRotation = multiply(inverse(targetBasis), reflectedWorldRotation)
    local mirroredRotation = quaternionToEulerXYZ(normalizeQuaternion(targetRotation, "Target pose rotation"))
    return mirroredPosition, mirroredRotation
end

return Mirror
