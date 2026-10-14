local IKSolver = {}

function IKSolver.isLimbJoint(name, slot)
    if type(name) ~= "string" or type(slot) ~= "string" then return false end
    local lower = string.lower(name)
    local side = string.find(slot, "Left", 1, true) and "left" or "right"
    if not string.find(lower, side, 1, true) then return false end
    local family = string.find(slot, "Hand", 1, true) and { "hand", "arm", "shoulder", "elbow", "wrist" } or { "foot", "leg", "knee", "ankle" }
    for _, token in family do if string.find(lower, token, 1, true) then return true end end
    return false
end

-- Returns a unit world-space axis and the shortest angle (radians) that swings
-- the current end-effector direction toward a target around the given pivot.
function IKSolver.step(pivotX, pivotY, pivotZ, endX, endY, endZ, goalX, goalY, goalZ)
    local fromX, fromY, fromZ = endX - pivotX, endY - pivotY, endZ - pivotZ
    local toX, toY, toZ = goalX - pivotX, goalY - pivotY, goalZ - pivotZ
    local fromLength = math.sqrt(fromX * fromX + fromY * fromY + fromZ * fromZ)
    local toLength = math.sqrt(toX * toX + toY * toY + toZ * toZ)
    if fromLength < 1e-5 or toLength < 1e-5 then return nil, nil, nil, 0, toLength end

    fromX, fromY, fromZ = fromX / fromLength, fromY / fromLength, fromZ / fromLength
    toX, toY, toZ = toX / toLength, toY / toLength, toZ / toLength
    local axisX = fromY * toZ - fromZ * toY
    local axisY = fromZ * toX - fromX * toZ
    local axisZ = fromX * toY - fromY * toX
    local axisLength = math.sqrt(axisX * axisX + axisY * axisY + axisZ * axisZ)
    local dot = math.clamp(fromX * toX + fromY * toY + fromZ * toZ, -1, 1)
    local angle = math.atan2(axisLength, dot)
    if axisLength < 1e-6 then
        if dot > 0 then return nil, nil, nil, 0, toLength end
        local helperX, helperY, helperZ = math.abs(fromX) < 0.8 and 1 or 0, math.abs(fromX) < 0.8 and 0 or 1, 0
        axisX = fromY * helperZ - fromZ * helperY
        axisY = fromZ * helperX - fromX * helperZ
        axisZ = fromX * helperY - fromY * helperX
        axisLength = math.sqrt(axisX * axisX + axisY * axisY + axisZ * axisZ)
    end
    return axisX / axisLength, axisY / axisLength, axisZ / axisLength, angle, toLength
end

-- Returns a world-space rotation around the root-to-effector line that aims
-- the limb's projected bend direction toward a pole target. Degenerate straight
-- limbs and pole targets on the limb axis are intentionally left unchanged.
function IKSolver.poleStep(rootX, rootY, rootZ, middleX, middleY, middleZ, endX, endY, endZ, poleX, poleY, poleZ)
    local axisX, axisY, axisZ = endX - rootX, endY - rootY, endZ - rootZ
    local axisLength = math.sqrt(axisX * axisX + axisY * axisY + axisZ * axisZ)
    if axisLength < 1e-5 then return nil, nil, nil, 0 end
    axisX, axisY, axisZ = axisX / axisLength, axisY / axisLength, axisZ / axisLength

    local currentX, currentY, currentZ = middleX - rootX, middleY - rootY, middleZ - rootZ
    local currentProjection = currentX * axisX + currentY * axisY + currentZ * axisZ
    currentX, currentY, currentZ = currentX - currentProjection * axisX, currentY - currentProjection * axisY, currentZ - currentProjection * axisZ
    local desiredX, desiredY, desiredZ = poleX - rootX, poleY - rootY, poleZ - rootZ
    local desiredProjection = desiredX * axisX + desiredY * axisY + desiredZ * axisZ
    desiredX, desiredY, desiredZ = desiredX - desiredProjection * axisX, desiredY - desiredProjection * axisY, desiredZ - desiredProjection * axisZ

    local currentLength = math.sqrt(currentX * currentX + currentY * currentY + currentZ * currentZ)
    local desiredLength = math.sqrt(desiredX * desiredX + desiredY * desiredY + desiredZ * desiredZ)
    if currentLength < 1e-5 or desiredLength < 1e-5 then return nil, nil, nil, 0 end
    currentX, currentY, currentZ = currentX / currentLength, currentY / currentLength, currentZ / currentLength
    desiredX, desiredY, desiredZ = desiredX / desiredLength, desiredY / desiredLength, desiredZ / desiredLength
    local crossX = currentY * desiredZ - currentZ * desiredY
    local crossY = currentZ * desiredX - currentX * desiredZ
    local crossZ = currentX * desiredY - currentY * desiredX
    local sine = axisX * crossX + axisY * crossY + axisZ * crossZ
    local cosine = math.clamp(currentX * desiredX + currentY * desiredY + currentZ * desiredZ, -1, 1)
    return axisX, axisY, axisZ, math.atan2(sine, cosine)
end

return IKSolver
