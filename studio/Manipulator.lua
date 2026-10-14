local Manipulator = {}

function Manipulator.projectAxis(screenX, screenY, worldLength)
    if type(screenX) ~= "number" or type(screenY) ~= "number" or type(worldLength) ~= "number" or worldLength <= 0 then return nil end
    local magnitude = math.sqrt(screenX * screenX + screenY * screenY)
    if magnitude <= 0.001 then return nil end
    return {
        x = screenX / magnitude,
        y = screenY / magnitude,
        studsPerPixel = worldLength / magnitude,
    }
end

function Manipulator.moveHandleHit(offsetX, offsetY, axisX, axisY, minimumAlong, maximumAlong, tolerance)
    local along = offsetX * axisX + offsetY * axisY
    local perpendicular = math.sqrt((offsetX - axisX * along) ^ 2 + (offsetY - axisY * along) ^ 2)
    return along >= minimumAlong and along <= maximumAlong and perpendicular <= tolerance, perpendicular
end

function Manipulator.ringHandleHit(offsetX, offsetY, radius, tolerance)
    return math.abs(math.sqrt(offsetX * offsetX + offsetY * offsetY) - radius) <= tolerance
end

function Manipulator.moveDelta(pointerDeltaX, pointerDeltaY, axisX, axisY, studsPerPixel)
    return (pointerDeltaX * axisX + pointerDeltaY * axisY) * studsPerPixel
end

function Manipulator.rotationDelta(startX, startY, currentX, currentY, pivotX, pivotY)
    local startAngle = math.atan2(startY - pivotY, startX - pivotX)
    local currentAngle = math.atan2(currentY - pivotY, currentX - pivotX)
    local delta = math.atan2(math.sin(currentAngle - startAngle), math.cos(currentAngle - startAngle))
    return math.deg(delta)
end

return Manipulator
