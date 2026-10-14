local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")
local TweenService = game:GetService("TweenService")
local BASE = "__BRIDGE_URL__"
local TOKEN = "__BRIDGE_TOKEN__"
local PLUGIN_BUILD_FINGERPRINT = "__PLUGIN_BUILD_FINGERPRINT__"
local sessionId = HttpService:GenerateGUID(false)
local connected, alive = true, true
local bridgeAvailable = false
local COLORS = {
    shell = Color3.fromRGB(3, 6, 12),
    surface = Color3.fromRGB(7, 11, 20),
    raised = Color3.fromRGB(10, 18, 32),
    control = Color3.fromRGB(14, 23, 40),
    controlHover = Color3.fromRGB(18, 39, 55),
    text = Color3.fromRGB(226, 232, 240),
    muted = Color3.fromRGB(126, 145, 165),
    accent = Color3.fromRGB(34, 216, 255),
    accentSoft = Color3.fromRGB(12, 55, 70),
    border = Color3.fromRGB(28, 91, 116),
}
local FONTS = {
    ui = Enum.Font.BuilderSans,
    data = Enum.Font.RobotoMono,
    heading = Enum.Font.BuilderSansBold,
    headingMedium = Enum.Font.BuilderSansMedium,
}
local UI = {}
local toolbar = plugin:CreateToolbar("Motion Tools")
local button = toolbar:CreateButton("MotionTools", "Open the Motion Tools animation studio", "rbxasset://textures/sparkle.png", "Animation Studio")
button.ClickableWhenViewportHidden = true

local info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, false, 1120, 760, 700, 500)
local widget = plugin:CreateDockWidgetPluginGuiAsync("RobloxMotionTools", info)
widget.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
widget.Title = "Motion Tools Animation Studio"
local shell = Instance.new("Frame")
shell.Name = "Workspace"
shell.Size = UDim2.fromScale(1, 1)
shell.BackgroundColor3 = COLORS.shell
shell.Parent = widget
UI.pointerPosition = function() return widget:GetRelativeMousePosition() end

local function text(parent, class, value, position, size)
    local control = Instance.new(class)
    control.Size, control.Position = size, position
    control.BackgroundColor3 = COLORS.control
    control.BorderSizePixel = 0
    control.TextColor3 = COLORS.text
    control.Font = FONTS.ui
    control.TextSize = 16
    control.TextWrapped = class == "TextBox"
    if class ~= "TextBox" then control.TextTruncate = Enum.TextTruncate.AtEnd end
    control.Text = value
    control:GetPropertyChangedSignal("TextSize"):Connect(function()
        if control.TextSize < 12 then control.TextSize = 12 end
    end)
    if control:IsA("TextButton") then control.AutoButtonColor = true end
    local corner = Instance.new("UICorner")
    corner.CornerRadius = UDim.new(0, 6)
    corner.Parent = control
    control.Parent = parent
    if control:IsA("TextButton") then
        control.AutoButtonColor = false
        local baseColor = control.BackgroundColor3
        control.MouseEnter:Connect(function()
            TweenService:Create(control, TweenInfo.new(0.12, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { BackgroundColor3 = COLORS.controlHover }):Play()
        end)
        control.MouseLeave:Connect(function()
            if control.Parent then TweenService:Create(control, TweenInfo.new(0.16, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { BackgroundColor3 = baseColor }):Play() end
        end)
        control.MouseButton1Down:Connect(function()
            TweenService:Create(control, TweenInfo.new(0.06), { BackgroundTransparency = 0.12 }):Play()
        end)
        control.MouseButton1Up:Connect(function()
            TweenService:Create(control, TweenInfo.new(0.1), { BackgroundTransparency = 0 }):Play()
        end)
    end
    return control
end

UI.hoverHint = Instance.new("TextLabel")
UI.hoverHint.Name = "HoverHint"
UI.hoverHint.Visible = false
UI.hoverHint.Active = false
UI.hoverHint.ZIndex = 100
UI.hoverHint.BackgroundColor3 = COLORS.raised
UI.hoverHint.BorderSizePixel = 0
UI.hoverHint.TextColor3 = COLORS.text
UI.hoverHint.Font = FONTS.ui
UI.hoverHint.TextSize = 12
UI.hoverHint.TextWrapped = true
UI.hoverHint.TextXAlignment = Enum.TextXAlignment.Left
UI.hoverHint.TextYAlignment = Enum.TextYAlignment.Center
UI.hoverHint.Parent = shell
UI.hoverHintCorner = Instance.new("UICorner")
UI.hoverHintCorner.CornerRadius = UDim.new(0, 5)
UI.hoverHintCorner.Parent = UI.hoverHint
UI.hoverHintStroke = Instance.new("UIStroke")
UI.hoverHintStroke.Color = COLORS.accent
UI.hoverHintStroke.Transparency = 0.35
UI.hoverHintStroke.Parent = UI.hoverHint
UI.tooltipBindings = setmetatable({}, { __mode = "k" })
local function setToolTip(target, message)
    target:SetAttribute("MotionTooltip", message)
    local binding = UI.tooltipBindings[target]
    if binding then binding.message = message; return end
    binding = { message = message }
    UI.tooltipBindings[target] = binding
    target.MouseEnter:Connect(function()
        if not target.Parent or binding.message == "" then return end
        local width = math.max(120, math.min(300, shell.AbsoluteSize.X - 16))
        local height = math.clamp(24 + math.ceil(#binding.message / 42) * 13, 38, 130)
        UI.hoverHint.Text = binding.message
        UI.hoverHint.Size = UDim2.fromOffset(width, height)
        local relativeX = target.AbsolutePosition.X - shell.AbsolutePosition.X
        local relativeY = target.AbsolutePosition.Y - shell.AbsolutePosition.Y
        local x = math.clamp(relativeX, 8, math.max(8, shell.AbsoluteSize.X - width - 8))
        local y = relativeY + target.AbsoluteSize.Y + 5
        if y + height > shell.AbsoluteSize.Y then y = relativeY - height - 5 end
        UI.hoverHint.Position = UDim2.fromOffset(x, math.max(4, y))
        UI.hoverHint.Visible = true
    end)
    target.MouseLeave:Connect(function() UI.hoverHint.Visible = false end)
end

UI.rigSwitchModal = Instance.new("Frame")
UI.rigSwitchModal.Name = "RigFormatConfirmation"
UI.rigSwitchModal.Size = UDim2.fromScale(1, 1)
UI.rigSwitchModal.BackgroundColor3 = COLORS.shell
UI.rigSwitchModal.BackgroundTransparency = 0.38
UI.rigSwitchModal.BorderSizePixel = 0
UI.rigSwitchModal.Active = true
UI.rigSwitchModal.Visible = false
UI.rigSwitchModal.ZIndex = 200
UI.rigSwitchModal.Parent = shell
UI.rigSwitchCard = Instance.new("Frame")
UI.rigSwitchCard.Name = "ConfirmationCard"
UI.rigSwitchCard.AnchorPoint = Vector2.new(0.5, 0.5)
UI.rigSwitchCard.Position = UDim2.fromScale(0.5, 0.5)
UI.rigSwitchCard.Size = UDim2.fromOffset(390, 198)
UI.rigSwitchCard.BackgroundColor3 = COLORS.surface
UI.rigSwitchCard.BorderSizePixel = 0
UI.rigSwitchCard.ZIndex = 201
UI.rigSwitchCard.Parent = UI.rigSwitchModal
UI.rigSwitchCardCorner = Instance.new("UICorner")
UI.rigSwitchCardCorner.CornerRadius = UDim.new(0, 10)
UI.rigSwitchCardCorner.Parent = UI.rigSwitchCard
UI.rigSwitchCardStroke = Instance.new("UIStroke")
UI.rigSwitchCardStroke.Color = COLORS.accent
UI.rigSwitchCardStroke.Transparency = 0.28
UI.rigSwitchCardStroke.Thickness = 1
UI.rigSwitchCardStroke.Parent = UI.rigSwitchCard
UI.rigSwitchTitle = text(UI.rigSwitchCard, "TextLabel", "SWITCH RIG FORMAT?", UDim2.fromOffset(18, 14), UDim2.new(1, -36, 0, 24))
UI.rigSwitchTitle.BackgroundTransparency = 1
UI.rigSwitchTitle.TextColor3 = COLORS.accent
UI.rigSwitchTitle.TextSize = 14
UI.rigSwitchTitle.Font = FONTS.heading
UI.rigSwitchTitle.TextXAlignment = Enum.TextXAlignment.Left
UI.rigSwitchTitle.ZIndex = 202
UI.rigSwitchMessage = text(UI.rigSwitchCard, "TextLabel", "", UDim2.fromOffset(18, 46), UDim2.new(1, -36, 0, 88))
UI.rigSwitchMessage.BackgroundTransparency = 1
UI.rigSwitchMessage.TextColor3 = COLORS.text
UI.rigSwitchMessage.TextSize = 12
UI.rigSwitchMessage.TextWrapped = true
UI.rigSwitchMessage.TextXAlignment = Enum.TextXAlignment.Left
UI.rigSwitchMessage.TextYAlignment = Enum.TextYAlignment.Top
UI.rigSwitchMessage.ZIndex = 202
UI.cancelRigSwitchButton = text(UI.rigSwitchCard, "TextButton", "Cancel", UDim2.new(1, -222, 1, -44), UDim2.fromOffset(92, 30))
UI.cancelRigSwitchButton.TextSize = 12
UI.cancelRigSwitchButton.ZIndex = 202
UI.confirmRigSwitchButton = text(UI.rigSwitchCard, "TextButton", "Replace rigs", UDim2.new(1, -122, 1, -44), UDim2.fromOffset(104, 30))
UI.confirmRigSwitchButton.TextSize = 11
UI.confirmRigSwitchButton.BackgroundColor3 = Color3.fromRGB(106, 53, 68)
UI.confirmRigSwitchButton.ZIndex = 202
local pendingRigType
local rigCreationPending = false

UI.header = Instance.new("Frame")
UI.header.Name = "Header"
UI.header.Size = UDim2.new(1, 0, 0, 64)
UI.header.BackgroundColor3 = COLORS.surface
UI.header.BackgroundTransparency = 0.08
UI.header.Parent = shell
UI.headerGradient = Instance.new("UIGradient")
UI.headerGradient.Color = ColorSequence.new({ ColorSequenceKeypoint.new(0, Color3.fromRGB(16, 38, 53)), ColorSequenceKeypoint.new(0.55, COLORS.surface), ColorSequenceKeypoint.new(1, Color3.fromRGB(20, 28, 46)) })
UI.headerGradient.Rotation = 0
UI.headerGradient.Parent = UI.header
UI.logoBadge = Instance.new("Frame")
UI.logoBadge.Name = "MotionToolsLogo"
UI.logoBadge.Position = UDim2.fromOffset(10, 8)
UI.logoBadge.Size = UDim2.fromOffset(28, 28)
UI.logoBadge.BackgroundColor3 = COLORS.accentSoft
UI.logoBadge.BorderSizePixel = 0
UI.logoBadge.ZIndex = 3
UI.logoBadge.Parent = UI.header
UI.logoCorner = Instance.new("UICorner")
UI.logoCorner.CornerRadius = UDim.new(0, 7)
UI.logoCorner.Parent = UI.logoBadge
UI.logoStroke = Instance.new("UIStroke")
UI.logoStroke.Color = COLORS.accent
UI.logoStroke.Transparency = 0.2
UI.logoStroke.Thickness = 1
UI.logoStroke.Parent = UI.logoBadge
UI.logoMark = text(UI.logoBadge, "TextLabel", "M", UDim2.fromOffset(0, -1), UDim2.fromScale(1, 1))
UI.logoMark.Name = "LogoMark"
UI.logoMark.BackgroundTransparency = 1
UI.logoMark.TextColor3 = COLORS.accent
UI.logoMark.TextSize = 20
UI.logoMark.ZIndex = 4
UI.accentLine = Instance.new("Frame")
UI.accentLine.Name = "CyanEdge"
UI.accentLine.Position = UDim2.new(0, 0, 1, -2)
UI.accentLine.Size = UDim2.new(1, 0, 0, 2)
UI.accentLine.BackgroundColor3 = COLORS.accent
UI.accentLine.BackgroundTransparency = 0.12
UI.accentLine.BorderSizePixel = 0
UI.accentLine.Parent = UI.header
UI.accentLineGradient = Instance.new("UIGradient")
UI.accentLineGradient.Transparency = NumberSequence.new({ NumberSequenceKeypoint.new(0, 0.1), NumberSequenceKeypoint.new(0.55, 0.65), NumberSequenceKeypoint.new(1, 0.08) })
UI.accentLineGradient.Parent = UI.accentLine
UI.title = text(UI.header, "TextLabel", "MOTION TOOLS", UDim2.fromOffset(46, 5), UDim2.fromOffset(136, 20))
UI.title.BackgroundTransparency = 1
UI.title.TextXAlignment = Enum.TextXAlignment.Left
UI.title.TextSize = 14
UI.title.TextColor3 = COLORS.muted
UI.title.Font = FONTS.heading
UI.connectionLabel = text(UI.header, "TextLabel", "Connecting…", UDim2.fromOffset(46, 28), UDim2.new(1, -154, 0, 24))
UI.connectionLabel.BackgroundTransparency = 1
UI.connectionLabel.TextXAlignment = Enum.TextXAlignment.Left
UI.connectionLabel.TextSize = 11
UI.connectionLabel.TextColor3 = COLORS.accent
UI.connectionLabel.Font = FONTS.ui
UI.connectButton = text(UI.header, "TextButton", "●", UDim2.fromOffset(11, 40), UDim2.fromOffset(30, 20))
UI.connectButton.TextSize = 12
UI.connectButton.BackgroundColor3 = COLORS.accentSoft
setToolTip(UI.connectButton, "Disconnect from Motion Tools")

UI.library = Instance.new("Frame")
UI.library.Name = "AnimationLibrary"
UI.library.Position = UDim2.fromOffset(0, 0)
UI.library.Size = UDim2.new(0, 52, 1, 0)
UI.library.BackgroundColor3 = COLORS.surface
UI.library.BackgroundTransparency = 0.04
UI.library.BorderSizePixel = 0
UI.library.Parent = shell
UI.library.ZIndex = 40
UI.header.Parent = UI.library
local libraryExpanded = false
local libraryPinned = false
local libraryWidth = 270
local railWidth = 52
local libraryTween
local hoverGeneration = 0
UI.rail = Instance.new("Frame")
UI.rail.Name = "IconRail"
UI.rail.Size = UDim2.new(1, 0, 1, 0)
UI.rail.BackgroundTransparency = 1
UI.rail.Parent = UI.library
UI.rigRailButton = text(UI.rail, "TextButton", "R", UDim2.fromOffset(7, 72), UDim2.fromOffset(38, 38))
UI.rigRailButton.Name = "RigLibraryTab"
UI.rigRailButton.TextSize = 18
UI.rigRailButton.TextColor3 = COLORS.accent
setToolTip(UI.rigRailButton, "Rig library and rig setup")
UI.animationRailButton = text(UI.rail, "TextButton", "A", UDim2.fromOffset(7, 118), UDim2.fromOffset(38, 38))
UI.animationRailButton.Name = "AnimationLibraryTab"
UI.animationRailButton.TextSize = 18
UI.animationRailButton.TextColor3 = COLORS.muted
setToolTip(UI.animationRailButton, "Saved animations")
UI.pinButton = text(UI.rail, "TextButton", "‹", UDim2.new(0, 7, 1, -46), UDim2.fromOffset(38, 38))
UI.pinButton.Name = "PinLibrary"
UI.pinButton.TextSize = 20
UI.pinButton.TextColor3 = COLORS.muted
setToolTip(UI.pinButton, "Pin the library open")
UI.rigHeader = text(UI.library, "TextLabel", "RIG LIBRARY", UDim2.fromOffset(64, 70), UDim2.new(1, -76, 0, 22))
UI.rigHeader.BackgroundTransparency = 1
UI.rigHeader.TextXAlignment = Enum.TextXAlignment.Left
UI.rigHeader.TextSize = 12
UI.rigHeader.Font = FONTS.headingMedium
UI.createRigButton = text(UI.library, "TextButton", "+ R15", UDim2.fromOffset(62, 98), UDim2.new(0.5, -66, 0, 32))
UI.rigOptionsButton = text(UI.library, "TextButton", "+ R6", UDim2.new(0.5, 4, 0, 98), UDim2.new(0.5, -66, 0, 32))
UI.rigSearchBox = text(UI.library, "TextBox", "", UDim2.fromOffset(62, 138), UDim2.new(1, -72, 0, 28))
UI.rigSearchBox.Name = "RigSearch"
UI.rigSearchBox.PlaceholderText = "Find a rig..."
UI.rigSearchBox.TextXAlignment = Enum.TextXAlignment.Left
UI.rigSearchBox.ClearTextOnFocus = false
UI.rigList = Instance.new("ScrollingFrame")
UI.rigList.Name = "RigList"
UI.rigList.Position = UDim2.fromOffset(62, 172)
UI.rigList.Size = UDim2.new(1, -72, 0, 126)
UI.rigList.BackgroundColor3 = COLORS.raised
UI.rigList.BorderSizePixel = 0
UI.rigList.ScrollBarThickness = 5
UI.rigList.Parent = UI.library
UI.workflowHint = text(UI.library, "TextLabel", "Choose a rig to open it in the animation viewport.", UDim2.fromOffset(62, 302), UDim2.new(1, -72, 0, 34))
UI.workflowHint.BackgroundTransparency = 1
UI.workflowHint.TextSize = 12
UI.workflowHint.TextXAlignment = Enum.TextXAlignment.Left
UI.workflowHint.TextColor3 = COLORS.muted
UI.animationHeader = text(UI.library, "TextLabel", "ANIMATIONS", UDim2.fromOffset(64, 342), UDim2.new(1, -76, 0, 22))
UI.animationHeader.BackgroundTransparency = 1
UI.animationHeader.TextXAlignment = Enum.TextXAlignment.Left
UI.animationHeader.TextSize = 12
UI.animationHeader.Font = FONTS.headingMedium
UI.refreshButton = text(UI.library, "TextButton", "Refresh library", UDim2.fromOffset(62, 368), UDim2.new(1, -72, 0, 30))
UI.animationSearchBox = text(UI.library, "TextBox", "", UDim2.fromOffset(62, 404), UDim2.new(1, -150, 0, 28))
UI.animationSearchBox.Name = "AnimationSearch"
UI.animationSearchBox.PlaceholderText = "Search clips..."
UI.animationSearchBox.TextXAlignment = Enum.TextXAlignment.Left
UI.animationSearchBox.ClearTextOnFocus = false
UI.revisionFilterButton = text(UI.library, "TextButton", "Latest", UDim2.new(1, -72, 0, 404), UDim2.fromOffset(62, 28))
UI.revisionFilterButton.Name = "RevisionFilter"
UI.revisionFilterButton.TextSize = 12
setToolTip(UI.revisionFilterButton, "Switch between latest revisions and all saved versions")
UI.dropdown = Instance.new("ScrollingFrame")
UI.dropdown.Name = "AnimationDropdown"
UI.dropdown.Position = UDim2.fromOffset(62, 438)
UI.dropdown.Size = UDim2.new(1, -72, 1, -448)
UI.dropdown.BackgroundColor3 = COLORS.raised
UI.dropdown.BorderSizePixel = 0
UI.dropdown.ScrollBarThickness = 6
UI.dropdown.Parent = UI.library

UI.editor = Instance.new("Frame")
UI.editor.Name = "Editor"
UI.editor.Position = UDim2.new(0, railWidth, 0, 0)
UI.editor.Size = UDim2.new(1, -railWidth, 1, 0)
UI.editor.BackgroundColor3 = COLORS.shell
UI.editor.BackgroundTransparency = 0.02
UI.editor.Parent = shell
UI.viewport = Instance.new("ViewportFrame")
UI.viewport.Name = "RigViewport"
UI.viewport.Position = UDim2.fromOffset(10, 10)
UI.viewport.Size = UDim2.new(1, -20, 1, -220)
UI.viewport.BackgroundColor3 = Color3.fromRGB(5, 12, 21)
UI.viewport.BackgroundTransparency = 0
UI.viewport.BorderSizePixel = 0
UI.viewport.Active = true
UI.viewport.Ambient = Color3.fromRGB(190, 190, 200)
UI.viewport.LightColor = Color3.fromRGB(255, 250, 238)
UI.viewport.LightDirection = Vector3.new(-0.7, -1, -0.6)
UI.viewport.Parent = UI.editor
local viewportClone, currentRecipe, previewRigModel, playbackConnection
local editorPreviewEffects
local activeLayerId
local onionGhosts, onionSkinEnabled = {}, false
local selectedKeyTrackIndex, selectedKeyIndex
local selectedKeys, keyMarkerByKey = {}, {}
local poseClipboard
local gizmoMode, gizmoDrag = "Select", nil
local gizmoScreenAxes = {}
local activeIKEffector = "RightHand"
local ikEffectorInfo = {}
local setIKEffector, refreshIKEffectors
local cloneRecipe
local pushUndoSnapshot
local recipeDirty = false
local previewLoop, playbackSpeed = false, 1
local transitionLoopEnabled = false
local timelineSnapEnabled, timelineSnapStep = true, 0.25
local timelineFrameSnapEnabled = false
local playbackRangeIn, playbackRangeOut
local draggingRangeHandle, draggingRangeHandleSnapLabel
local timelineViewStart, timelineViewSpan = 0, nil
local updatePlaybackControls
local playbackFrameRates, playbackFrameRateIndex = { 24, 30, 60 }, 2
local playbackToggleButton
local undoStack, redoStack = {}, {}
local reviewMarkers, selectedReviewMarker = {}, nil
local selectedEventIndex
local draggingSemanticKey
local draggingContactHandle
local maximumUndoSteps = 100
local minimumZoom, maximumZoom = 2, 40
local orbitFocus = Vector3.zero
local orbitYaw, orbitPitch, orbitDistance = 0, math.rad(8), 12
local viewportCameraBookmark
local camera
UI.viewportStroke = Instance.new("UIStroke")
UI.viewportStroke.Color = COLORS.border
UI.viewportStroke.Thickness = 1
UI.viewportStroke.Transparency = 0.38
UI.viewportStroke.Parent = UI.viewport
UI.viewportGlow = Instance.new("UIStroke")
UI.viewportGlow.Color = COLORS.accent
UI.viewportGlow.Thickness = 2
UI.viewportGlow.Transparency = 1
UI.viewportGlow.Parent = UI.viewport
UI.axisWidget = Instance.new("Frame")
UI.axisWidget.Name = "ViewOrientationGizmo"
UI.axisWidget.AnchorPoint = Vector2.new(1, 0)
UI.axisWidget.Position = UDim2.new(1, -14, 0, 14)
UI.axisWidget.Size = UDim2.fromOffset(104, 104)
UI.axisWidget.BackgroundColor3 = Color3.fromRGB(6, 12, 22)
UI.axisWidget.BackgroundTransparency = 0.02
UI.axisWidget.BorderSizePixel = 0
UI.axisWidget.ZIndex = 5
UI.axisWidget.Parent = UI.viewport
UI.axisWidgetCorner = Instance.new("UICorner")
UI.axisWidgetCorner.CornerRadius = UDim.new(1, 0)
UI.axisWidgetCorner.Parent = UI.axisWidget
UI.axisWidgetStroke = Instance.new("UIStroke")
UI.axisWidgetStroke.Color = COLORS.accent
UI.axisWidgetStroke.Transparency = 0.58
UI.axisWidgetStroke.Thickness = 1
UI.axisWidgetStroke.Parent = UI.axisWidget
UI.axisCenter = Instance.new("Frame")
UI.axisCenter.Name = "Center"
UI.axisCenter.AnchorPoint = Vector2.new(0.5, 0.5)
UI.axisCenter.Position = UDim2.fromScale(0.5, 0.5)
UI.axisCenter.Size = UDim2.fromOffset(8, 8)
UI.axisCenter.BackgroundColor3 = COLORS.text
UI.axisCenter.BorderSizePixel = 0
UI.axisCenter.ZIndex = 6
UI.axisCenter.Parent = UI.axisWidget
UI.axisCenterCorner = Instance.new("UICorner")
UI.axisCenterCorner.CornerRadius = UDim.new(1, 0)
UI.axisCenterCorner.Parent = UI.axisCenter
UI.axisCaption = text(UI.axisWidget, "TextLabel", "WORLD", UDim2.new(0, 0, 1, -17), UDim2.new(1, 0, 0, 12))
UI.axisCaption.Name = "AxisCaption"
UI.axisCaption.BackgroundTransparency = 1
UI.axisCaption.TextColor3 = COLORS.muted
UI.axisCaption.TextSize = 8
UI.axisCaption.Font = FONTS.headingMedium
UI.axisCaption.ZIndex = 7
local axisDirections = {
    { label = "X", face = "+", vector = Vector3.xAxis, color = Color3.fromRGB(244, 104, 113), backColor = Color3.fromRGB(115, 48, 58) },
    { label = "X", face = "−", vector = -Vector3.xAxis, color = Color3.fromRGB(210, 86, 96), backColor = Color3.fromRGB(99, 42, 51) },
    { label = "Y", face = "+", vector = Vector3.yAxis, color = Color3.fromRGB(116, 224, 151), backColor = Color3.fromRGB(47, 101, 70) },
    { label = "Y", face = "−", vector = -Vector3.yAxis, color = Color3.fromRGB(83, 183, 119), backColor = Color3.fromRGB(39, 84, 60) },
    { label = "Z", face = "+", vector = Vector3.zAxis, color = Color3.fromRGB(108, 169, 255), backColor = Color3.fromRGB(47, 75, 119) },
    { label = "Z", face = "−", vector = -Vector3.zAxis, color = Color3.fromRGB(80, 137, 224), backColor = Color3.fromRGB(39, 62, 99) },
}
UI.axisButtons = {}
for index, direction in axisDirections do
    local axisButton = text(UI.axisWidget, "TextButton", direction.label, UDim2.fromOffset(0, 0), UDim2.fromOffset(34, 26))
    axisButton.Name = "Axis" .. tostring(index)
    axisButton.AnchorPoint = Vector2.new(0.5, 0.5)
    axisButton.BackgroundColor3 = direction.color
    axisButton.TextSize = 12
    axisButton.Font = FONTS.heading
    axisButton.TextWrapped = false
    axisButton.TextColor3 = Color3.fromRGB(5, 12, 20)
    axisButton.AutoButtonColor = true
    axisButton.ZIndex = 7
    local axisCorner = Instance.new("UICorner")
    axisCorner.CornerRadius = UDim.new(1, 0)
    axisCorner.Parent = axisButton
    local faceMark = text(axisButton, "TextLabel", direction.face, UDim2.new(1, -9, 0, 1), UDim2.fromOffset(8, 10))
    faceMark.Name = "DirectionSign"
    faceMark.BackgroundTransparency = 1
    faceMark.TextSize = 8
    faceMark.Font = FONTS.heading
    faceMark.TextColor3 = Color3.fromRGB(5, 12, 20)
    faceMark.ZIndex = 8
    setToolTip(axisButton, "Look from world " .. direction.face .. direction.label)
    table.insert(UI.axisButtons, axisButton)
    axisButton.MouseButton1Click:Connect(function()
        if not viewportClone then return end
        orbitYaw = 0
        orbitPitch = 0
        if math.abs(direction.vector.Y) > 0.9 then
            orbitPitch = direction.vector.Y > 0 and math.rad(82) or math.rad(-82)
        else
            orbitYaw = math.atan2(direction.vector.X, direction.vector.Z)
        end
        local cameraOffset = CFrame.fromOrientation(orbitPitch, orbitYaw, 0).LookVector * -orbitDistance
        camera.CFrame = CFrame.lookAt(orbitFocus + cameraOffset, orbitFocus, math.abs(direction.vector.Y) > 0.9 and Vector3.zAxis or Vector3.yAxis)
        updateViewportHud()
    end)
end
UI.gizmoToolbar = Instance.new("Frame")
UI.gizmoToolbar.Name = "JointTransformToolbar"
UI.gizmoToolbar.Position = UDim2.fromOffset(12, 158)
UI.gizmoToolbar.Size = UDim2.fromOffset(284, 64)
UI.gizmoToolbar.BackgroundColor3 = COLORS.surface
UI.gizmoToolbar.BackgroundTransparency = 0.04
UI.gizmoToolbar.BorderSizePixel = 0
UI.gizmoToolbar.Visible = false
UI.gizmoToolbar.ZIndex = 12
UI.gizmoToolbar.Parent = UI.viewport
setToolTip(UI.gizmoToolbar, "Joint transform tools · Q Select · G Move · R Rotate")
do
local gizmoToolbarCorner = Instance.new("UICorner")
gizmoToolbarCorner.CornerRadius = UDim.new(0, 7)
gizmoToolbarCorner.Parent = UI.gizmoToolbar
end
UI.gizmoModeButtons = {}
local setGizmoMode
for index, mode in { "Select", "Move", "Rotate", "IK" } do
    local button = text(UI.gizmoToolbar, "TextButton", mode, UDim2.fromOffset(5 + (index - 1) * 69, 4), UDim2.fromOffset(66, 24))
    button.Name = "Gizmo" .. mode
    button.TextSize = 10
    button.ZIndex = 13
    UI.gizmoModeButtons[mode] = button
    button.Activated:Connect(function() if setGizmoMode then setGizmoMode(mode) end end)
end
UI.ikEffectorRow = Instance.new("Frame")
UI.ikEffectorRow.Name = "IKEffectorRow"
UI.ikEffectorRow.Position = UDim2.fromOffset(0, 32)
UI.ikEffectorRow.Size = UDim2.new(1, 0, 0, 32)
UI.ikEffectorRow.BackgroundTransparency = 1
UI.ikEffectorRow.Visible = false
UI.ikEffectorRow.ZIndex = 12
UI.ikEffectorRow.Parent = UI.gizmoToolbar
UI.ikEffectorButtons = {}
for index, slot in { "LeftHand", "RightHand", "LeftFoot", "RightFoot" } do
    local shortName = ({ LeftHand = "L Hand", RightHand = "R Hand", LeftFoot = "L Foot", RightFoot = "R Foot" })[slot]
    local button = text(UI.ikEffectorRow, "TextButton", shortName, UDim2.fromOffset(5 + (index - 1) * 69, 4), UDim2.fromOffset(66, 24))
    button.Name = "IKEffector" .. slot
    button.TextSize = 9
    button.ZIndex = 13
    UI.ikEffectorButtons[slot] = button
    setToolTip(button, "Choose the " .. slot .. " end effector to pose with inverse kinematics")
    button.Activated:Connect(function() if setIKEffector then setIKEffector(slot) end end)
end
UI.jointManipulator = Instance.new("Frame")
UI.jointManipulator.Name = "JointManipulator"
UI.jointManipulator.Size = UDim2.fromOffset(180, 180)
UI.jointManipulator.BackgroundTransparency = 1
UI.jointManipulator.BorderSizePixel = 0
UI.jointManipulator.Visible = false
UI.jointManipulator.Active = false
UI.jointManipulator.ZIndex = 20
UI.jointManipulator.Parent = UI.viewport
UI.gizmoPivot = Instance.new("Frame")
UI.gizmoPivot.Name = "Pivot"
UI.gizmoPivot.AnchorPoint = Vector2.new(0.5, 0.5)
UI.gizmoPivot.Position = UDim2.fromOffset(90, 90)
UI.gizmoPivot.Size = UDim2.fromOffset(8, 8)
UI.gizmoPivot.BackgroundColor3 = COLORS.text
UI.gizmoPivot.BorderSizePixel = 0
UI.gizmoPivot.ZIndex = 24
UI.gizmoPivot.Parent = UI.jointManipulator
do
local gizmoPivotCorner = Instance.new("UICorner")
gizmoPivotCorner.CornerRadius = UDim.new(1, 0)
gizmoPivotCorner.Parent = UI.gizmoPivot
end
UI.ikTargetHalo = Instance.new("Frame")
UI.ikTargetHalo.Name = "IKTargetHalo"
UI.ikTargetHalo.AnchorPoint = Vector2.new(0.5, 0.5)
UI.ikTargetHalo.Position = UDim2.fromOffset(90, 90)
UI.ikTargetHalo.Size = UDim2.fromOffset(34, 34)
UI.ikTargetHalo.BackgroundTransparency = 1
UI.ikTargetHalo.BorderSizePixel = 0
UI.ikTargetHalo.Visible = false
UI.ikTargetHalo.ZIndex = 23
UI.ikTargetHalo.Parent = UI.jointManipulator
do
local ikTargetHaloCorner = Instance.new("UICorner")
ikTargetHaloCorner.CornerRadius = UDim.new(1, 0)
ikTargetHaloCorner.Parent = UI.ikTargetHalo
local ikTargetHaloStroke = Instance.new("UIStroke")
ikTargetHaloStroke.Color = COLORS.accent
ikTargetHaloStroke.Thickness = 2
ikTargetHaloStroke.Transparency = 0.06
ikTargetHaloStroke.Parent = UI.ikTargetHalo
end
local gizmoAxisColors = { Color3.fromRGB(244, 104, 113), Color3.fromRGB(116, 224, 151), Color3.fromRGB(108, 169, 255) }
UI.gizmoAxisLines, UI.gizmoAxisLabels, UI.gizmoRotationRings = {}, {}, {}
for axis = 1, 3 do
    local line = Instance.new("Frame")
    line.Name = "MoveAxis" .. axis
    line.AnchorPoint = Vector2.new(0, 0.5)
    line.Size = UDim2.fromOffset(58, 3)
    line.BackgroundColor3 = gizmoAxisColors[axis]
    line.BorderSizePixel = 0
    line.Visible = false
    line.ZIndex = 22
    line.Parent = UI.jointManipulator
    UI.gizmoAxisLines[axis] = line
    local label = text(UI.jointManipulator, "TextLabel", ({ "X", "Y", "Z" })[axis], UDim2.fromOffset(0, 0), UDim2.fromOffset(18, 18))
    label.Name = "MoveAxisLabel" .. axis
    label.AnchorPoint = Vector2.new(0.5, 0.5)
    label.Size = UDim2.fromOffset(18, 18)
    label.BackgroundColor3 = gizmoAxisColors[axis]
    label.TextColor3 = COLORS.shell
    label.TextSize = 9
    label.Font = FONTS.heading
    label.Visible = false
    label.ZIndex = 23
    UI.gizmoAxisLabels[axis] = label
    local ring = Instance.new("Frame")
    ring.Name = "RotationRing" .. axis
    ring.AnchorPoint = Vector2.new(0.5, 0.5)
    ring.Position = UDim2.fromOffset(90, 90)
    ring.Size = UDim2.fromOffset(48 + (axis - 1) * 18, 48 + (axis - 1) * 18)
    ring.BackgroundTransparency = 1
    ring.BorderSizePixel = 0
    ring.Visible = false
    ring.ZIndex = 21 + axis
    ring.Parent = UI.jointManipulator
    local ringCorner = Instance.new("UICorner")
    ringCorner.CornerRadius = UDim.new(1, 0)
    ringCorner.Parent = ring
    local ringStroke = Instance.new("UIStroke")
    ringStroke.Color = gizmoAxisColors[axis]
    ringStroke.Transparency = 0.12
    ringStroke.Thickness = 2
    ringStroke.Parent = ring
    UI.gizmoRotationRings[axis] = ring
end
camera = Instance.new("Camera")
camera.FieldOfView = 40
camera.Parent = UI.viewport
UI.viewport.CurrentCamera = camera
local world = Instance.new("WorldModel")
world.Name = "PreviewWorld"
world.Parent = UI.viewport
local ikCandidatePreview = {}
UI.viewportHint = text(UI.viewport, "TextLabel", "Choose a rig from the Rig Library to preview it here.", UDim2.fromOffset(12, 12), UDim2.new(1, -24, 0, 40))
UI.viewportHint.Name = "ViewportState"
UI.viewportHint.Size = UDim2.fromOffset(278, 46)
UI.viewportHint.BackgroundColor3 = COLORS.surface
UI.viewportHint.BackgroundTransparency = 0.16
UI.viewportHint.TextColor3 = COLORS.muted
UI.viewportHint.TextSize = 12
UI.viewportHint.Font = FONTS.data
UI.viewportHint.TextXAlignment = Enum.TextXAlignment.Left
UI.viewportHint.TextYAlignment = Enum.TextYAlignment.Center
UI.viewportHint.Text = "NO RIG LOADED\nSelect a rig to preview it here."
UI.viewportHint.ZIndex = 4
UI.draftStateBadge = text(UI.viewport, "TextLabel", "NO CLIP", UDim2.fromOffset(12, 202), UDim2.fromOffset(146, 24))
UI.draftStateBadge.Name = "DraftState"
UI.draftStateBadge.BackgroundColor3 = COLORS.raised
UI.draftStateBadge.BackgroundTransparency = 0.08
UI.draftStateBadge.TextColor3 = COLORS.muted
UI.draftStateBadge.TextSize = 9
UI.draftStateBadge.Font = FONTS.data
UI.draftStateBadge.ZIndex = 5
UI.draftStateStroke = Instance.new("UIStroke")
UI.draftStateStroke.Color = COLORS.border
UI.draftStateStroke.Transparency = 0.35
UI.draftStateStroke.Parent = UI.draftStateBadge
setToolTip(UI.draftStateBadge, "Shows whether this viewport is displaying a saved revision or an unsaved candidate/edit.")
do
local viewportHintCorner = Instance.new("UICorner")
viewportHintCorner.CornerRadius = UDim.new(0, 7)
viewportHintCorner.Parent = UI.viewportHint
local viewportHintStroke = Instance.new("UIStroke")
viewportHintStroke.Color = COLORS.border
viewportHintStroke.Transparency = 0.58
viewportHintStroke.Parent = UI.viewportHint
end
UI.candidatePreviewBanner = Instance.new("Frame")
UI.candidatePreviewBanner.Name = "IKCandidatePreviewBanner"
UI.candidatePreviewBanner.AnchorPoint = Vector2.new(0.5, 0)
UI.candidatePreviewBanner.Position = UDim2.new(0.5, 0, 0, 12)
UI.candidatePreviewBanner.Size = UDim2.fromOffset(330, 34)
UI.candidatePreviewBanner.BackgroundColor3 = COLORS.surface
UI.candidatePreviewBanner.BackgroundTransparency = 0.08
UI.candidatePreviewBanner.BorderSizePixel = 0
UI.candidatePreviewBanner.Visible = false
UI.candidatePreviewBanner.ZIndex = 12
UI.candidatePreviewBanner.Parent = UI.viewport
UI.candidatePreviewBannerCorner = Instance.new("UICorner")
UI.candidatePreviewBannerCorner.CornerRadius = UDim.new(0, 8)
UI.candidatePreviewBannerCorner.Parent = UI.candidatePreviewBanner
UI.candidatePreviewBannerStroke = Instance.new("UIStroke")
UI.candidatePreviewBannerStroke.Color = COLORS.accent
UI.candidatePreviewBannerStroke.Transparency = 0.2
UI.candidatePreviewBannerStroke.Thickness = 1
UI.candidatePreviewBannerStroke.Parent = UI.candidatePreviewBanner
UI.candidatePreviewLabel = text(UI.candidatePreviewBanner, "TextLabel", "IK CANDIDATE  ·  VISUAL ONLY", UDim2.fromOffset(12, 0), UDim2.new(1, -58, 1, 0))
UI.candidatePreviewLabel.BackgroundTransparency = 1
UI.candidatePreviewLabel.TextColor3 = COLORS.accent
UI.candidatePreviewLabel.TextSize = 10
UI.candidatePreviewLabel.Font = FONTS.data
UI.candidatePreviewLabel.TextXAlignment = Enum.TextXAlignment.Left
UI.candidatePreviewLabel.ZIndex = 13
UI.candidatePreviewClearButton = text(UI.candidatePreviewBanner, "TextButton", "×", UDim2.new(1, -34, 0, 4), UDim2.fromOffset(26, 26))
UI.candidatePreviewClearButton.BackgroundColor3 = COLORS.control
UI.candidatePreviewClearButton.TextColor3 = COLORS.text
UI.candidatePreviewClearButton.TextSize = 16
UI.candidatePreviewClearButton.ZIndex = 13
setToolTip(UI.candidatePreviewClearButton, "Hide the visual-only IK candidate ghost")
UI.candidatePreviewClearButton.MouseButton1Click:Connect(function()
    if ikCandidatePreview.clear then ikCandidatePreview.clear() end
end)
UI.onionSkinButton = text(UI.viewport, "TextButton", "Ghosts · Off", UDim2.fromOffset(12, 64), UDim2.fromOffset(86, 24))
UI.onionSkinButton.Name = "OnionSkinToggle"
UI.onionSkinButton.TextSize = 9
UI.onionSkinButton.ZIndex = 5
setToolTip(UI.onionSkinButton, "Overlay the previous and next key poses for the selected joint (onion skinning)")
UI.transitionLoopButton = text(UI.viewport, "TextButton", "Range · Off", UDim2.fromOffset(104, 64), UDim2.fromOffset(76, 24))
UI.transitionLoopButton.Name = "TransitionLoopToggle"
UI.transitionLoopButton.TextSize = 9
UI.transitionLoopButton.ZIndex = 5
setToolTip(UI.transitionLoopButton, "When enabled, Play ping-pongs between the selected joint key's neighboring poses")
UI.snapToggleButton = text(UI.viewport, "TextButton", "Snap · On", UDim2.fromOffset(186, 64), UDim2.fromOffset(74, 24))
UI.snapToggleButton.Name = "TimelineSnapToggle"
UI.snapToggleButton.TextSize = 9
UI.snapToggleButton.ZIndex = 5
UI.snapToggleButton.BackgroundColor3 = COLORS.accentSoft
setToolTip(UI.snapToggleButton, "Cycle key-drag snapping: Off → 0.25s beats → selected FPS frames")
UI.snapToggleButton.MouseButton1Click:Connect(function()
    if not timelineSnapEnabled then
        timelineSnapEnabled, timelineFrameSnapEnabled = true, false
    elseif not timelineFrameSnapEnabled then
        timelineFrameSnapEnabled, timelineSnapEnabled = true, true
    else
        timelineSnapEnabled, timelineFrameSnapEnabled = false, false
    end
    UI.snapToggleButton.Text = not timelineSnapEnabled and "Snap · Off" or timelineFrameSnapEnabled and "Snap · Frame" or "Snap · Beat"
    UI.snapToggleButton.BackgroundColor3 = timelineSnapEnabled and COLORS.accentSoft or COLORS.control
    local frameRate = playbackFrameRates[playbackFrameRateIndex]
    UI.status.Text = not timelineSnapEnabled and "Key dragging is free placement; neighbor ordering is still enforced." or timelineFrameSnapEnabled and string.format("Key dragging snaps to %d fps frames and nearby timeline landmarks.", frameRate) or "Key dragging snaps to 0.25s beats and nearby timeline landmarks."
end)
UI.frameRateButton = text(UI.viewport, "TextButton", "30 FPS", UDim2.fromOffset(266, 64), UDim2.fromOffset(68, 24))
UI.frameRateButton.Name = "FrameStepRate"
UI.frameRateButton.TextSize = 9
UI.frameRateButton.ZIndex = 5
setToolTip(UI.frameRateButton, "Frame-step rate · click to cycle 24, 30, and 60 fps")
UI.frameRigButton = text(UI.viewport, "TextButton", "Frame Rig", UDim2.fromOffset(340, 64), UDim2.fromOffset(62, 24))
UI.frameRigButton.Name = "FrameRig"
UI.frameRigButton.TextSize = 9
UI.frameRigButton.ZIndex = 5
setToolTip(UI.frameRigButton, "Recenter and fit the loaded rig in the viewport (F)")
UI.saveViewButton = text(UI.viewport, "TextButton", "Save View", UDim2.fromOffset(408, 64), UDim2.fromOffset(58, 24))
UI.saveViewButton.Name = "SaveCameraBookmark"
UI.saveViewButton.TextSize = 9
UI.saveViewButton.ZIndex = 5
setToolTip(UI.saveViewButton, "Save the current viewport angle, focus, distance, and field of view for this Studio session")
UI.restoreViewButton = text(UI.viewport, "TextButton", "View ↺", UDim2.fromOffset(470, 64), UDim2.fromOffset(54, 24))
UI.restoreViewButton.Name = "RestoreCameraBookmark"
UI.restoreViewButton.TextSize = 9
UI.restoreViewButton.ZIndex = 5
setToolTip(UI.restoreViewButton, "Restore the saved viewport camera bookmark")
UI.frameRateButton.MouseButton1Click:Connect(function()
    playbackFrameRateIndex = playbackFrameRateIndex % #playbackFrameRates + 1
    local frameRate = playbackFrameRates[playbackFrameRateIndex]
    UI.frameRateButton.Text = string.format("%d FPS", frameRate)
    UI.status.Text = string.format("Frame stepping set to %d fps (%.4fs per frame).", frameRate, 1 / frameRate)
    if timelineFrameSnapEnabled then
        UI.status.Text = string.format("Frame stepping and key snapping set to %d fps (%.4fs per frame).", frameRate, 1 / frameRate)
    end
end)
UI.setRangeInButton = text(UI.viewport, "TextButton", "Set In", UDim2.fromOffset(12, 94), UDim2.fromOffset(50, 24))
UI.setRangeInButton.TextSize = 9
UI.setRangeInButton.ZIndex = 5
setToolTip(UI.setRangeInButton, "Set the playback-range start at the current playhead")
UI.setRangeOutButton = text(UI.viewport, "TextButton", "Set Out", UDim2.fromOffset(66, 94), UDim2.fromOffset(56, 24))
UI.setRangeOutButton.TextSize = 9
UI.setRangeOutButton.ZIndex = 5
setToolTip(UI.setRangeOutButton, "Set the playback-range end at the current playhead")
UI.clearPlaybackRangeButton = text(UI.viewport, "TextButton", "Clear", UDim2.fromOffset(126, 94), UDim2.fromOffset(42, 24))
UI.clearPlaybackRangeButton.TextSize = 9
UI.clearPlaybackRangeButton.ZIndex = 5
setToolTip(UI.clearPlaybackRangeButton, "Clear the custom playback range and return to the full clip")
UI.playbackRangeLabel = text(UI.viewport, "TextLabel", "FULL CLIP", UDim2.fromOffset(174, 94), UDim2.fromOffset(130, 24))
UI.playbackRangeLabel.BackgroundTransparency = 1
UI.playbackRangeLabel.TextColor3 = COLORS.muted
UI.playbackRangeLabel.TextSize = 9
UI.playbackRangeLabel.Font = FONTS.data
UI.playbackRangeLabel.TextXAlignment = Enum.TextXAlignment.Left
UI.playbackRangeLabel.ZIndex = 5
UI.curveToggleButton = text(UI.viewport, "TextButton", "CURVE EDITOR", UDim2.new(1, -124, 0, 94), UDim2.fromOffset(112, 24))
UI.curveToggleButton.Name = "CurveEditorToggle"
UI.curveToggleButton.TextSize = 9
UI.curveToggleButton.Visible = false
UI.curveToggleButton.ZIndex = 6
setToolTip(UI.curveToggleButton, "Open the Bézier curve editor for the selected key's outgoing pose segment")
UI.rangeInLabel = text(UI.viewport, "TextLabel", "IN", UDim2.fromOffset(12, 126), UDim2.fromOffset(18, 24))
UI.rangeInLabel.BackgroundTransparency = 1
UI.rangeInLabel.TextSize = 9
UI.rangeInLabel.TextColor3 = COLORS.muted
UI.rangeInLabel.Font = FONTS.data
UI.rangeInLabel.ZIndex = 5
UI.rangeInBox = text(UI.viewport, "TextBox", "", UDim2.fromOffset(30, 126), UDim2.fromOffset(64, 24))
UI.rangeInBox.Name = "PlaybackRangeIn"
UI.rangeInBox.PlaceholderText = "0.000"
UI.rangeInBox.ClearTextOnFocus = false
UI.rangeInBox.TextSize = 10
UI.rangeInBox.Font = FONTS.data
UI.rangeInBox.ZIndex = 5
UI.rangeOutLabel = text(UI.viewport, "TextLabel", "OUT", UDim2.fromOffset(102, 126), UDim2.fromOffset(28, 24))
UI.rangeOutLabel.BackgroundTransparency = 1
UI.rangeOutLabel.TextSize = 9
UI.rangeOutLabel.TextColor3 = COLORS.muted
UI.rangeOutLabel.Font = FONTS.data
UI.rangeOutLabel.ZIndex = 5
UI.rangeOutBox = text(UI.viewport, "TextBox", "", UDim2.fromOffset(130, 126), UDim2.fromOffset(64, 24))
UI.rangeOutBox.Name = "PlaybackRangeOut"
UI.rangeOutBox.PlaceholderText = "—"
UI.rangeOutBox.ClearTextOnFocus = false
UI.rangeOutBox.TextSize = 10
UI.rangeOutBox.Font = FONTS.data
UI.rangeOutBox.ZIndex = 5
UI.reviewMarkerNameBox = text(UI.viewport, "TextBox", "", UDim2.fromOffset(202, 126), UDim2.fromOffset(210, 24))
UI.reviewMarkerNameBox.Name = "ReviewMarkerName"
UI.reviewMarkerNameBox.PlaceholderText = "Name selected review marker…"
UI.reviewMarkerNameBox.ClearTextOnFocus = false
UI.reviewMarkerNameBox.TextSize = 10
UI.reviewMarkerNameBox.Visible = false
UI.reviewMarkerNameBox.ZIndex = 5
setToolTip(UI.reviewMarkerNameBox, "Rename this session-only pose bookmark; it does not alter the saved animation recipe")
local function updateViewportHud()
    if UI.updateDraftState then UI.updateDraftState() end
    if not previewRigModel then
        UI.viewportHint.Text = "NO RIG LOADED\nSelect a rig to preview it here."
        return
    end
    local editHint = currentRecipe and "CLICK A JOINT TO EDIT" or "LOAD AN ANIMATION TO EDIT"
    UI.viewportHint.Text = string.format("RIG  %s\nVIEW  ·  %.1f studs  ·  FOV %d°\n%s", previewRigModel.Name, orbitDistance, math.floor(camera.FieldOfView + 0.5), editHint)
end
updateViewportHud()
UI.keyEditor = Instance.new("Frame")
UI.keyEditor.Name = "KeyframeInspector"
UI.keyEditor.Position = UDim2.new(0, 12, 1, -330)
UI.keyEditor.Size = UDim2.fromOffset(270, 320)
UI.keyEditor.BackgroundColor3 = COLORS.surface
UI.keyEditor.BackgroundTransparency = 0.06
UI.keyEditor.BorderSizePixel = 0
UI.keyEditor.Visible = false
UI.keyEditor.ZIndex = 8
UI.keyEditor.Parent = UI.viewport
UI.keyEditorCorner = Instance.new("UICorner")
UI.keyEditorCorner.CornerRadius = UDim.new(0, 8)
UI.keyEditorCorner.Parent = UI.keyEditor
UI.keyEditorStroke = Instance.new("UIStroke")
UI.keyEditorStroke.Color = COLORS.accent
UI.keyEditorStroke.Transparency = 0.3
UI.keyEditorStroke.Thickness = 1
UI.keyEditorStroke.Parent = UI.keyEditor
UI.curvePanel = Instance.new("Frame")
UI.curvePanel.Name = "BezierCurveEditor"
UI.curvePanel.AnchorPoint = Vector2.new(1, 1)
UI.curvePanel.Position = UDim2.new(1, -14, 1, -14)
UI.curvePanel.Size = UDim2.fromOffset(324, 254)
UI.curvePanel.BackgroundColor3 = COLORS.surface
UI.curvePanel.BackgroundTransparency = 0.02
UI.curvePanel.BorderSizePixel = 0
UI.curvePanel.Visible = false
UI.curvePanel.ZIndex = 10
UI.curvePanel.Parent = UI.viewport
UI.curvePanelCorner = Instance.new("UICorner")
UI.curvePanelCorner.CornerRadius = UDim.new(0, 8)
UI.curvePanelCorner.Parent = UI.curvePanel
UI.curvePanelStroke = Instance.new("UIStroke")
UI.curvePanelStroke.Color = COLORS.accent
UI.curvePanelStroke.Transparency = 0.3
UI.curvePanelStroke.Parent = UI.curvePanel
UI.curveTitle = text(UI.curvePanel, "TextLabel", "SEGMENT CURVE", UDim2.fromOffset(12, 8), UDim2.new(1, -84, 0, 20))
UI.curveTitle.BackgroundTransparency = 1
UI.curveTitle.TextXAlignment = Enum.TextXAlignment.Left
UI.curveTitle.TextColor3 = COLORS.accent
UI.curveTitle.Font = FONTS.headingMedium
UI.curveTitle.TextSize = 11
UI.curveTitle.ZIndex = 11
UI.curveCloseButton = text(UI.curvePanel, "TextButton", "×", UDim2.new(1, -34, 0, 5), UDim2.fromOffset(26, 24))
UI.curveCloseButton.ZIndex = 11
UI.curveGraph = Instance.new("Frame")
UI.curveGraph.Name = "BezierGraph"
UI.curveGraph.Position = UDim2.fromOffset(18, 38)
UI.curveGraph.Size = UDim2.new(1, -36, 0, 174)
UI.curveGraph.BackgroundColor3 = COLORS.raised
UI.curveGraph.BorderSizePixel = 0
UI.curveGraph.ClipsDescendants = true
UI.curveGraph.ZIndex = 11
UI.curveGraph.Parent = UI.curvePanel
UI.curveHint = text(UI.curvePanel, "TextLabel", "Drag handles · click graph to scrub · normalized pose progress", UDim2.fromOffset(12, 220), UDim2.new(1, -24, 0, 24))
UI.curveHint.BackgroundTransparency = 1
UI.curveHint.TextColor3 = COLORS.muted
UI.curveHint.Font = FONTS.data
UI.curveHint.TextSize = 8
UI.curveHint.TextXAlignment = Enum.TextXAlignment.Left
UI.curveHint.ZIndex = 11
UI.layersToggleButton = text(UI.viewport, "TextButton", "ANIMATION LAYERS", UDim2.new(1, -136, 0, 126), UDim2.fromOffset(124, 24))
UI.layersToggleButton.Name = "AnimationLayersToggle"
UI.layersToggleButton.TextSize = 9
UI.layersToggleButton.Visible = false
UI.layersToggleButton.ZIndex = 6
setToolTip(UI.layersToggleButton, "Manage non-destructive additive and override animation layers")
UI.layerPanel = Instance.new("Frame")
UI.layerPanel.Name = "AnimationLayerStack"
UI.layerPanel.AnchorPoint = Vector2.new(1, 0)
UI.layerPanel.Position = UDim2.new(1, -14, 0, 158)
UI.layerPanel.Size = UDim2.fromOffset(296, 386)
UI.layerPanel.BackgroundColor3 = COLORS.surface
UI.layerPanel.BackgroundTransparency = 0.02
UI.layerPanel.BorderSizePixel = 0
UI.layerPanel.Visible = false
UI.layerPanel.ZIndex = 10
UI.layerPanel.Parent = UI.viewport
do
local layerPanelCorner = Instance.new("UICorner")
layerPanelCorner.CornerRadius = UDim.new(0, 8)
layerPanelCorner.Parent = UI.layerPanel
local layerPanelStroke = Instance.new("UIStroke")
layerPanelStroke.Color = COLORS.accent
layerPanelStroke.Transparency = 0.3
layerPanelStroke.Parent = UI.layerPanel
end
UI.layerPanelTitle = text(UI.layerPanel, "TextLabel", "POSE LAYERS", UDim2.fromOffset(12, 8), UDim2.new(1, -54, 0, 20))
UI.layerPanelTitle.BackgroundTransparency = 1
UI.layerPanelTitle.TextXAlignment = Enum.TextXAlignment.Left
UI.layerPanelTitle.TextColor3 = COLORS.accent
UI.layerPanelTitle.Font = FONTS.headingMedium
UI.layerPanelTitle.TextSize = 11
UI.layerPanelTitle.ZIndex = 11
UI.layerCloseButton = text(UI.layerPanel, "TextButton", "×", UDim2.new(1, -34, 0, 5), UDim2.fromOffset(26, 24))
UI.layerCloseButton.ZIndex = 11
UI.layerBaseButton = text(UI.layerPanel, "TextButton", "BASE ANIMATION", UDim2.fromOffset(10, 34), UDim2.new(1, -20, 0, 24))
UI.layerBaseButton.TextSize = 9
UI.layerBaseButton.ZIndex = 11
UI.layerList = Instance.new("ScrollingFrame")
UI.layerList.Name = "LayerStackList"
UI.layerList.Position = UDim2.fromOffset(10, 64)
UI.layerList.Size = UDim2.new(1, -20, 0, 112)
UI.layerList.BackgroundColor3 = COLORS.raised
UI.layerList.BorderSizePixel = 0
UI.layerList.ScrollBarThickness = 4
UI.layerList.CanvasSize = UDim2.fromOffset(0, 0)
UI.layerList.ZIndex = 11
UI.layerList.Parent = UI.layerPanel
UI.layerOverrideButton = text(UI.layerPanel, "TextButton", "+ Override", UDim2.fromOffset(10, 182), UDim2.new(0.5, -14, 0, 24))
UI.layerOverrideButton.TextSize = 9
UI.layerOverrideButton.ZIndex = 11
UI.layerAdditiveButton = text(UI.layerPanel, "TextButton", "+ Additive", UDim2.new(0.5, 4, 0, 182), UDim2.new(0.5, -14, 0, 24))
UI.layerAdditiveButton.TextSize = 9
UI.layerAdditiveButton.ZIndex = 11
UI.layerModeButton = text(UI.layerPanel, "TextButton", "Mode · —", UDim2.fromOffset(10, 212), UDim2.new(0.5, -14, 0, 24))
UI.layerModeButton.TextSize = 9
UI.layerModeButton.ZIndex = 11
UI.layerEnabledButton = text(UI.layerPanel, "TextButton", "Enabled · —", UDim2.new(0.5, 4, 0, 212), UDim2.new(0.5, -14, 0, 24))
UI.layerEnabledButton.TextSize = 9
UI.layerEnabledButton.ZIndex = 11
UI.layerWeightBox = text(UI.layerPanel, "TextBox", "100", UDim2.fromOffset(10, 242), UDim2.fromOffset(70, 24))
UI.layerWeightBox.Name = "LayerWeightPercent"
UI.layerWeightBox.PlaceholderText = "Weight %"
UI.layerWeightBox.ClearTextOnFocus = false
UI.layerWeightBox.TextSize = 10
UI.layerWeightBox.ZIndex = 11
UI.layerWeightHint = text(UI.layerPanel, "TextLabel", "WEIGHT  ·  %", UDim2.fromOffset(86, 242), UDim2.new(1, -96, 0, 24))
UI.layerWeightHint.BackgroundTransparency = 1
UI.layerWeightHint.TextColor3 = COLORS.muted
UI.layerWeightHint.TextSize = 9
UI.layerWeightHint.TextXAlignment = Enum.TextXAlignment.Left
UI.layerWeightHint.ZIndex = 11
UI.layerMoveUpButton = text(UI.layerPanel, "TextButton", "Move ↑", UDim2.fromOffset(10, 272), UDim2.new(0.33, -8, 0, 24))
UI.layerMoveUpButton.TextSize = 9
UI.layerMoveUpButton.ZIndex = 11
UI.layerMoveDownButton = text(UI.layerPanel, "TextButton", "Move ↓", UDim2.new(0.33, 2, 0, 272), UDim2.new(0.33, -8, 0, 24))
UI.layerMoveDownButton.TextSize = 9
UI.layerMoveDownButton.ZIndex = 11
UI.layerDeleteButton = text(UI.layerPanel, "TextButton", "Delete", UDim2.new(0.66, 2, 0, 272), UDim2.new(0.34, -12, 0, 24))
UI.layerDeleteButton.TextSize = 9
UI.layerDeleteButton.BackgroundColor3 = Color3.fromRGB(82, 44, 56)
UI.layerDeleteButton.ZIndex = 11
UI.layerTracksTitle = text(UI.layerPanel, "TextLabel", "ADD BASE JOINT TRACKS", UDim2.fromOffset(10, 302), UDim2.new(1, -20, 0, 16))
UI.layerTracksTitle.BackgroundTransparency = 1
UI.layerTracksTitle.TextColor3 = COLORS.muted
UI.layerTracksTitle.TextSize = 8
UI.layerTracksTitle.TextXAlignment = Enum.TextXAlignment.Left
UI.layerTracksTitle.ZIndex = 11
UI.layerBaseTrackList = Instance.new("ScrollingFrame")
UI.layerBaseTrackList.Name = "AvailableBaseTracks"
UI.layerBaseTrackList.Position = UDim2.fromOffset(10, 322)
UI.layerBaseTrackList.Size = UDim2.new(1, -20, 1, -330)
UI.layerBaseTrackList.BackgroundColor3 = COLORS.raised
UI.layerBaseTrackList.BorderSizePixel = 0
UI.layerBaseTrackList.ScrollBarThickness = 4
UI.layerBaseTrackList.CanvasSize = UDim2.fromOffset(0, 0)
UI.layerBaseTrackList.ZIndex = 11
UI.layerBaseTrackList.Parent = UI.layerPanel
UI.keyEditorTitle = text(UI.keyEditor, "TextLabel", "KEYFRAME POSE", UDim2.fromOffset(10, 6), UDim2.new(1, -20, 0, 18))
UI.keyEditorTitle.Size = UDim2.fromOffset(100, 18)
UI.keyEditorTitle.BackgroundTransparency = 1
UI.keyEditorTitle.TextSize = 14
UI.keyEditorTitle.TextColor3 = COLORS.accent
UI.keyEditorTitle.Font = FONTS.headingMedium
UI.keyEditorTitle.TextXAlignment = Enum.TextXAlignment.Left
UI.keyEditorTitle.ZIndex = 9
UI.mirrorPoseButton = text(UI.keyEditor, "TextButton", "Mirror", UDim2.new(1, -154, 0, 5), UDim2.fromOffset(42, 20))
UI.mirrorPoseButton.TextSize = 9
UI.mirrorPoseButton.ZIndex = 9
setToolTip(UI.mirrorPoseButton, "Reflect this pose across the rig-local X plane using each joint's measured rest orientation")
UI.copyPoseButton = text(UI.keyEditor, "TextButton", "Copy", UDim2.new(1, -106, 0, 5), UDim2.fromOffset(42, 20))
UI.copyPoseButton.TextSize = 9
UI.copyPoseButton.ZIndex = 9
setToolTip(UI.copyPoseButton, "Copy this key's position and rotation for the same joint")
UI.pastePoseButton = text(UI.keyEditor, "TextButton", "Paste", UDim2.new(1, -58, 0, 5), UDim2.fromOffset(48, 20))
UI.pastePoseButton.TextSize = 9
UI.pastePoseButton.ZIndex = 9
UI.pastePoseButton.Active = false
UI.pastePoseButton.TextTransparency = 0.5
setToolTip(UI.pastePoseButton, "Copy a pose from this same joint first")
UI.keyEditorJoint = text(UI.keyEditor, "TextLabel", "Select a key", UDim2.fromOffset(10, 25), UDim2.new(1, -98, 0, 18))
UI.keyEditorJoint.BackgroundTransparency = 1
UI.keyEditorJoint.TextSize = 13
UI.keyEditorJoint.TextXAlignment = Enum.TextXAlignment.Left
UI.keyEditorJoint.ZIndex = 9
UI.keyTimeBox = text(UI.keyEditor, "TextBox", "0.00", UDim2.new(1, -78, 0, 24), UDim2.fromOffset(68, 22))
UI.keyTimeBox.Name = "KeyTime"
UI.keyTimeBox.TextSize = 12
UI.keyTimeBox.Font = FONTS.data
UI.keyTimeBox.ClearTextOnFocus = false
UI.keyTimeBox.ZIndex = 9
UI.keyTimeRangeHint = text(UI.keyEditor, "TextLabel", "Select a key to see its timing range", UDim2.fromOffset(10, 44), UDim2.new(1, -20, 0, 12))
UI.keyTimeRangeHint.BackgroundTransparency = 1
UI.keyTimeRangeHint.TextSize = 9
UI.keyTimeRangeHint.TextColor3 = COLORS.muted
UI.keyTimeRangeHint.TextXAlignment = Enum.TextXAlignment.Left
UI.keyTimeRangeHint.ZIndex = 9
UI.positionLabel = text(UI.keyEditor, "TextLabel", "POSITION", UDim2.fromOffset(10, 54), UDim2.fromOffset(82, 16))
UI.positionLabel.BackgroundTransparency = 1
UI.positionLabel.TextSize = 12
UI.positionLabel.TextColor3 = COLORS.muted
UI.positionLabel.TextXAlignment = Enum.TextXAlignment.Left
UI.positionLabel.ZIndex = 9
UI.rotationLabel = text(UI.keyEditor, "TextLabel", "ROTATION °", UDim2.fromOffset(10, 99), UDim2.fromOffset(82, 16))
UI.rotationLabel.BackgroundTransparency = 1
UI.rotationLabel.TextSize = 12
UI.rotationLabel.TextColor3 = COLORS.muted
UI.rotationLabel.TextXAlignment = Enum.TextXAlignment.Left
UI.rotationLabel.ZIndex = 9
local positionBoxes, rotationBoxes = {}, {}
for index, axis in { "X", "Y", "Z" } do
    local posBox = text(UI.keyEditor, "TextBox", "0", UDim2.fromOffset(10 + (index - 1) * 84, 70), UDim2.fromOffset(78, 24))
    posBox.Name = "Position" .. axis
    posBox.TextSize = 12
    posBox.Font = FONTS.data
    posBox.ClearTextOnFocus = false
    posBox.ZIndex = 9
    table.insert(positionBoxes, posBox)
    local rotBox = text(UI.keyEditor, "TextBox", "0", UDim2.fromOffset(10 + (index - 1) * 84, 115), UDim2.fromOffset(78, 24))
    rotBox.Name = "Rotation" .. axis
    rotBox.TextSize = 12
    rotBox.Font = FONTS.data
    rotBox.ClearTextOnFocus = false
    rotBox.ZIndex = 9
    table.insert(rotationBoxes, rotBox)
end
UI.easingStyleButton = text(UI.keyEditor, "TextButton", "Linear", UDim2.fromOffset(10, 140), UDim2.new(0.5, -15, 0, 20))
UI.easingStyleButton.TextSize = 10
UI.easingStyleButton.ZIndex = 9
setToolTip(UI.easingStyleButton, "Outgoing segment interpolation. Linear, Constant, Cubic, Bounce and Elastic shapes are available.")
UI.easingDirectionButton = text(UI.keyEditor, "TextButton", "Out", UDim2.new(0.5, 5, 0, 140), UDim2.new(0.5, -15, 0, 20))
UI.easingDirectionButton.TextSize = 10
UI.easingDirectionButton.ZIndex = 9
setToolTip(UI.easingDirectionButton, "Easing direction for the segment from this key to the next.")
UI.poseSpacingHint = text(UI.keyEditor, "TextLabel", "NEIGHBORS  ·  Select a key", UDim2.fromOffset(10, 163), UDim2.new(1, -20, 0, 12))
UI.poseSpacingHint.BackgroundTransparency = 1
UI.poseSpacingHint.Font = FONTS.data
UI.poseSpacingHint.TextSize = 11
UI.poseSpacingHint.TextColor3 = COLORS.muted
UI.poseSpacingHint.TextXAlignment = Enum.TextXAlignment.Left
UI.poseSpacingHint.TextTruncate = Enum.TextTruncate.AtEnd
UI.poseSpacingHint.ZIndex = 9
setToolTip(UI.poseSpacingHint, "Neighbor gaps are seconds; Δpos is local studs; Δrot is the shortest local angular distance in degrees. Metrics describe this joint only, not animation quality.")
UI.applyKeyButton = text(UI.keyEditor, "TextButton", "Apply Pose", UDim2.fromOffset(10, 180), UDim2.fromOffset(78, 30))
UI.applyKeyButton.TextSize = 10
UI.applyKeyButton.BackgroundColor3 = COLORS.accentSoft
UI.applyKeyButton.ZIndex = 9
UI.insertKeyButton = text(UI.keyEditor, "TextButton", "Insert Key", UDim2.fromOffset(94, 180), UDim2.fromOffset(88, 30))
UI.insertKeyButton.TextSize = 11
setToolTip(UI.insertKeyButton, "Insert the selected joint's current interpolated pose at the timeline playhead")
UI.insertKeyButton.ZIndex = 9
UI.deleteKeyButton = text(UI.keyEditor, "TextButton", "Delete", UDim2.new(1, -82, 0, 180), UDim2.fromOffset(72, 30))
UI.deleteKeyButton.TextSize = 11
UI.deleteKeyButton.BackgroundColor3 = Color3.fromRGB(82, 44, 56)
UI.deleteKeyButton.ZIndex = 9
UI.poseNameBox = text(UI.keyEditor, "TextBox", "", UDim2.fromOffset(10, 218), UDim2.new(1, -102, 0, 24))
UI.poseNameBox.Name = "ReusablePoseName"
UI.poseNameBox.PlaceholderText = "Name pose or snapshot…"
UI.poseNameBox.ClearTextOnFocus = false
UI.poseNameBox.TextSize = 10
UI.poseNameBox.ZIndex = 9
UI.savePoseButton = text(UI.keyEditor, "TextButton", "Save Pose", UDim2.new(1, -86, 0, 218), UDim2.fromOffset(76, 24))
UI.savePoseButton.TextSize = 10
UI.savePoseButton.ZIndex = 9
setToolTip(UI.savePoseButton, "Save the selected joint transform as a reusable, searchable pose asset for you and your AI agent.")
UI.openPoseLibraryButton = text(UI.keyEditor, "TextButton", "Browse Pose Library", UDim2.fromOffset(10, 248), UDim2.new(1, -20, 0, 24))
UI.openPoseLibraryButton.TextSize = 10
UI.openPoseLibraryButton.ZIndex = 9
setToolTip(UI.openPoseLibraryButton, "Search saved reusable poses and apply one to the selected animation key.")
UI.captureSnapshotButton = text(UI.keyEditor, "TextButton", "Capture Full-Body Snapshot", UDim2.fromOffset(10, 278), UDim2.new(1, -20, 0, 28))
UI.captureSnapshotButton.TextSize = 10
UI.captureSnapshotButton.BackgroundColor3 = COLORS.accentSoft
UI.captureSnapshotButton.ZIndex = 9
setToolTip(UI.captureSnapshotButton, "Capture every driven joint's evaluated pose at the playhead as a rig-aware snapshot.")
UI.poseLibraryPanel = Instance.new("Frame")
UI.poseLibraryPanel.Name = "ReusablePoseLibrary"
UI.poseLibraryPanel.Position = UDim2.new(0, 290, 1, -330)
UI.poseLibraryPanel.Size = UDim2.fromOffset(250, 320)
UI.poseLibraryPanel.BackgroundColor3 = COLORS.surface
UI.poseLibraryPanel.BackgroundTransparency = 0.04
UI.poseLibraryPanel.BorderSizePixel = 0
UI.poseLibraryPanel.Visible = false
UI.poseLibraryPanel.ZIndex = 8
UI.poseLibraryPanel.Parent = UI.viewport
UI.poseLibraryPanelCorner = Instance.new("UICorner")
UI.poseLibraryPanelCorner.CornerRadius = UDim.new(0, 8)
UI.poseLibraryPanelCorner.Parent = UI.poseLibraryPanel
UI.poseLibraryTitle = text(UI.poseLibraryPanel, "TextLabel", "REUSABLE POSES", UDim2.fromOffset(10, 7), UDim2.new(1, -48, 0, 20))
UI.poseLibraryTitle.BackgroundTransparency = 1
UI.poseLibraryTitle.TextXAlignment = Enum.TextXAlignment.Left
UI.poseLibraryTitle.TextColor3 = COLORS.accent
UI.poseLibraryTitle.TextSize = 11
UI.poseLibraryTitle.Font = FONTS.headingMedium
UI.poseLibraryTitle.ZIndex = 9
UI.closePoseLibraryButton = text(UI.poseLibraryPanel, "TextButton", "×", UDim2.new(1, -32, 0, 5), UDim2.fromOffset(24, 24))
UI.closePoseLibraryButton.ZIndex = 9
UI.poseSearchBox = text(UI.poseLibraryPanel, "TextBox", "", UDim2.fromOffset(8, 34), UDim2.new(1, -16, 0, 24))
UI.poseSearchBox.PlaceholderText = "Search names, tags, joints…"
UI.poseSearchBox.ClearTextOnFocus = false
UI.poseSearchBox.TextSize = 10
UI.poseSearchBox.ZIndex = 9
UI.poseList = Instance.new("ScrollingFrame")
UI.poseList.Name = "PoseResults"
UI.poseList.Position = UDim2.fromOffset(8, 64)
UI.poseList.Size = UDim2.new(1, -16, 1, -104)
UI.poseList.BackgroundTransparency = 1
UI.poseList.BorderSizePixel = 0
UI.poseList.ScrollBarThickness = 4
UI.poseList.ScrollBarImageColor3 = COLORS.border
UI.poseList.CanvasSize = UDim2.fromOffset(0, 0)
UI.poseList.ZIndex = 9
UI.poseList.Parent = UI.poseLibraryPanel
UI.applyLibraryPoseButton = text(UI.poseLibraryPanel, "TextButton", "Apply Pose", UDim2.new(0, 8, 1, -32), UDim2.new(1, -16, 0, 24))
UI.applyLibraryPoseButton.TextSize = 10
UI.applyLibraryPoseButton.BackgroundColor3 = COLORS.accentSoft
UI.applyLibraryPoseButton.Active = false
UI.applyLibraryPoseButton.TextTransparency = 0.5
UI.applyLibraryPoseButton.ZIndex = 9

UI.timeline = Instance.new("Frame")
UI.timeline.Name = "Timeline"
UI.timeline.Position = UDim2.new(0, 10, 1, -200)
UI.timeline.Size = UDim2.new(1, -20, 0, 190)
UI.timeline.BackgroundColor3 = COLORS.surface
UI.timeline.BackgroundTransparency = 0.02
UI.timeline.Parent = UI.editor
UI.timelineStroke = Instance.new("UIStroke")
UI.timelineStroke.Color = COLORS.border
UI.timelineStroke.Thickness = 1
UI.timelineStroke.Transparency = 0.5
UI.timelineStroke.Parent = UI.timeline
UI.selectedLabel = text(UI.timeline, "TextLabel", "No animation selected", UDim2.fromOffset(10, 6), UDim2.new(1, -410, 0, 20))
UI.selectedLabel.BackgroundTransparency = 1
UI.selectedLabel.TextXAlignment = Enum.TextXAlignment.Left
UI.selectedLabel.TextSize = 13
UI.selectedLabel.TextColor3 = COLORS.text
UI.selectedLabel.TextTruncate = Enum.TextTruncate.AtEnd
UI.undoButton = text(UI.timeline, "TextButton", "Undo", UDim2.new(1, -396, 0, 5), UDim2.fromOffset(48, 24))
UI.undoButton.TextSize = 11
setToolTip(UI.undoButton, "Undo local animation edit")
UI.redoButton = text(UI.timeline, "TextButton", "Redo", UDim2.new(1, -342, 0, 5), UDim2.fromOffset(48, 24))
UI.redoButton.TextSize = 11
setToolTip(UI.redoButton, "Redo local animation edit")
UI.saveRevisionButton = text(UI.timeline, "TextButton", "Save Revision", UDim2.new(1, -228, 0, 5), UDim2.fromOffset(104, 24))
UI.saveRevisionButton.TextSize = 12
UI.saveRevisionButton.BackgroundColor3 = COLORS.accentSoft
UI.revertButton = text(UI.timeline, "TextButton", "Revert", UDim2.new(1, -284, 0, 5), UDim2.fromOffset(50, 24))
UI.revertButton.TextSize = 12
UI.saveButton = text(UI.timeline, "TextButton", "Save to Studio", UDim2.new(1, -116, 0, 5), UDim2.fromOffset(104, 24))
UI.saveButton.TextSize = 11
UI.saveButton.BackgroundColor3 = COLORS.accentSoft
UI.timelineHint = text(UI.timeline, "TextLabel", "1.0×", UDim2.fromOffset(10, 36), UDim2.fromOffset(34, 16))
UI.timelineHint.BackgroundTransparency = 1
UI.timelineHint.TextSize = 9
UI.timelineHint.TextColor3 = COLORS.muted
UI.timelineHint.TextXAlignment = Enum.TextXAlignment.Left
UI.timelineHint.Font = FONTS.data
setToolTip(UI.timelineHint, "Shift-click keyframes to select a group, then drag any selected key to retime them together. Ctrl + wheel zooms around the cursor; Shift + wheel pans.")
UI.timelineFitButton = text(UI.timeline, "TextButton", "Fit", UDim2.fromOffset(48, 36), UDim2.fromOffset(24, 16))
UI.timelineFitButton.TextSize = 8
setToolTip(UI.timelineFitButton, "Fit the custom playback range to the timeline; if none is set, fit the full clip")
UI.timelineResetZoomButton = text(UI.timeline, "TextButton", "1:1", UDim2.fromOffset(74, 36), UDim2.fromOffset(26, 16))
UI.timelineResetZoomButton.TextSize = 8
setToolTip(UI.timelineResetZoomButton, "Reset zoom and pan to show the entire clip")
UI.ruler = Instance.new("Frame")
UI.ruler.Name = "KeyframeTimeline"
UI.ruler.Position = UDim2.fromOffset(100, 36)
UI.ruler.Size = UDim2.new(1, -112, 0, 112)
UI.ruler.BackgroundColor3 = COLORS.raised
UI.ruler.BackgroundTransparency = 0.06
UI.ruler.BorderSizePixel = 0
UI.ruler.ClipsDescendants = true
UI.ruler.Parent = UI.timeline
UI.rulerCorner = Instance.new("UICorner")
UI.rulerCorner.CornerRadius = UDim.new(0, 5)
UI.rulerCorner.Parent = UI.ruler
UI.rulerStroke = Instance.new("UIStroke")
UI.rulerStroke.Color = COLORS.border
UI.rulerStroke.Transparency = 0.72
UI.rulerStroke.Thickness = 1
UI.rulerStroke.Parent = UI.ruler
UI.rulerLine = Instance.new("Frame")
UI.rulerLine.Name = "TrackLine"
UI.rulerLine.AnchorPoint = Vector2.new(0.5, 0.5)
UI.rulerLine.Position = UDim2.new(0.5, 0, 0.5, 0)
UI.rulerLine.Size = UDim2.new(1, -16, 0, 2)
UI.rulerLine.BackgroundColor3 = COLORS.border
UI.rulerLine.BackgroundTransparency = 0.25
UI.rulerLine.BorderSizePixel = 0
UI.rulerLine.Parent = UI.ruler
UI.rulerTicks = Instance.new("Frame")
UI.rulerTicks.Name = "TimeRuler"
UI.rulerTicks.Size = UDim2.fromScale(1, 1)
UI.rulerTicks.BackgroundTransparency = 1
UI.rulerTicks.Parent = UI.ruler
UI.trackNames = Instance.new("ScrollingFrame")
UI.trackNames.Name = "JointTracks"
UI.trackNames.Position = UDim2.fromOffset(10, 54)
UI.trackNames.Size = UDim2.fromOffset(86, 94)
UI.trackNames.BackgroundTransparency = 1
UI.trackNames.BorderSizePixel = 0
UI.trackNames.ScrollBarThickness = 4
UI.trackNames.ScrollBarImageColor3 = COLORS.border
UI.trackNames.CanvasSize = UDim2.fromOffset(0, 0)
UI.trackNames.Parent = UI.timeline
UI.trackArea = Instance.new("ScrollingFrame")
UI.trackArea.Name = "KeyframeTracks"
UI.trackArea.Position = UDim2.fromOffset(0, 20)
UI.trackArea.Size = UDim2.new(1, 0, 1, -20)
UI.trackArea.BackgroundTransparency = 1
UI.trackArea.BorderSizePixel = 0
UI.trackArea.ScrollBarThickness = 4
UI.trackArea.ScrollBarImageColor3 = COLORS.border
UI.trackArea.CanvasSize = UDim2.fromOffset(0, 0)
UI.trackArea.Parent = UI.ruler
UI.keyMarkers = Instance.new("Frame")
UI.keyMarkers.Name = "Keyframes"
UI.keyMarkers.Size = UDim2.new(1, 0, 0, 0)
UI.keyMarkers.BackgroundTransparency = 1
UI.keyMarkers.Parent = UI.trackArea
UI.playhead = Instance.new("Frame")
UI.playhead.Name = "Playhead"
UI.playhead.AnchorPoint = Vector2.new(0.5, 0)
UI.playhead.Position = UDim2.new(0, 8, 0, 0)
UI.playhead.Size = UDim2.new(0, 2, 0, 0)
UI.playhead.BackgroundColor3 = COLORS.accent
UI.playhead.BorderSizePixel = 0
UI.playhead.ZIndex = 5
UI.playhead.Active = true
UI.playhead.Selectable = false
UI.playhead.Parent = UI.trackArea
UI.playheadGlow = Instance.new("UIStroke")
UI.playheadGlow.Color = COLORS.accent
UI.playheadGlow.Transparency = 0.68
UI.playheadGlow.Thickness = 4
UI.playheadGlow.Parent = UI.playhead
setToolTip(UI.playhead, "Drag the playhead to scrub and preview poses smoothly")
UI.scrubber = text(UI.timeline, "TextBox", "0.00", UDim2.fromOffset(220, 156), UDim2.fromOffset(64, 25))
UI.scrubber.Name = "Scrubber"
UI.scrubber.ClearTextOnFocus = false
UI.scrubber.Font = FONTS.data
UI.addMarkerButton = text(UI.timeline, "TextButton", "Note", UDim2.fromOffset(290, 156), UDim2.fromOffset(62, 25))
UI.addMarkerButton.TextSize = 10
setToolTip(UI.addMarkerButton, "Add a session-only review note at the current playhead; use + Event for a persistent animation marker")
UI.removeMarkerButton = text(UI.timeline, "TextButton", "−", UDim2.fromOffset(356, 156), UDim2.fromOffset(26, 25))
UI.removeMarkerButton.TextSize = 13
setToolTip(UI.removeMarkerButton, "Remove the selected session-only review note")
UI.removeMarkerButton.Active = false
UI.removeMarkerButton.TextTransparency = 0.5
UI.addEventButton = text(UI.timeline, "TextButton", "+ Event", UDim2.fromOffset(388, 156), UDim2.fromOffset(58, 25))
UI.addEventButton.Name = "AddAnimationEvent"
UI.addEventButton.TextSize = 10
setToolTip(UI.addEventButton, "Add a persistent animation event at the playhead; it is saved and exported with the clip")
UI.removeEventButton = text(UI.timeline, "TextButton", "−", UDim2.fromOffset(450, 156), UDim2.fromOffset(26, 25))
UI.removeEventButton.Name = "RemoveAnimationEvent"
UI.removeEventButton.TextSize = 13
setToolTip(UI.removeEventButton, "Remove the selected persistent animation event")
UI.removeEventButton.Active = false
UI.removeEventButton.TextTransparency = 0.5
UI.previousKeyButton = text(UI.timeline, "TextButton", "|◀", UDim2.fromOffset(10, 156), UDim2.fromOffset(26, 25))
UI.previousKeyButton.TextSize = 10
setToolTip(UI.previousKeyButton, "Previous keyframe (←)")
UI.previousFrameButton = text(UI.timeline, "TextButton", "−", UDim2.fromOffset(38, 156), UDim2.fromOffset(20, 25))
UI.previousFrameButton.TextSize = 12
setToolTip(UI.previousFrameButton, "Step back one frame (Shift + ←)")
playbackToggleButton = text(UI.timeline, "TextButton", "▶", UDim2.fromOffset(60, 156), UDim2.fromOffset(32, 25))
playbackToggleButton.Name = "PlaybackToggle"
playbackToggleButton.TextSize = 13
playbackToggleButton.BackgroundColor3 = COLORS.accentSoft
setToolTip(playbackToggleButton, "Play or stop (Space)")
UI.nextFrameButton = text(UI.timeline, "TextButton", "+", UDim2.fromOffset(94, 156), UDim2.fromOffset(20, 25))
UI.nextFrameButton.TextSize = 12
setToolTip(UI.nextFrameButton, "Step forward one frame (Shift + →)")
UI.nextKeyButton = text(UI.timeline, "TextButton", "▶|", UDim2.fromOffset(116, 156), UDim2.fromOffset(26, 25))
UI.nextKeyButton.TextSize = 10
setToolTip(UI.nextKeyButton, "Next keyframe (→)")
UI.loopPreviewButton = text(UI.timeline, "TextButton", "Loop", UDim2.fromOffset(146, 156), UDim2.fromOffset(40, 25))
UI.loopPreviewButton.TextSize = 11
setToolTip(UI.loopPreviewButton, "Toggle looping for viewport playback only")
UI.playbackSpeedButton = text(UI.timeline, "TextButton", "1×", UDim2.fromOffset(190, 156), UDim2.fromOffset(28, 25))
UI.playbackSpeedButton.TextSize = 11
setToolTip(UI.playbackSpeedButton, "Cycle preview speed")
UI.scrubber.Position = UDim2.fromOffset(222, 156)
UI.addMarkerButton.Position = UDim2.fromOffset(290, 156)
UI.status = text(UI.timeline, "TextLabel", "Choose a rig, then choose an animation to preview.", UDim2.fromOffset(484, 156), UDim2.new(1, -686, 0, 25))
UI.status.BackgroundTransparency = 1
UI.status.TextSize = 11
UI.status.TextColor3 = COLORS.muted
UI.status.Font = FONTS.ui
UI.status.TextTruncate = Enum.TextTruncate.AtEnd
UI.durationLabel = text(UI.timeline, "TextLabel", "/ 0.00s", UDim2.new(1, -96, 0, 156), UDim2.fromOffset(84, 25))
UI.durationLabel.BackgroundTransparency = 1
UI.durationLabel.TextColor3 = COLORS.muted
UI.compressClipButton = text(UI.timeline, "TextButton", "−20%", UDim2.new(1, -194, 0, 156), UDim2.fromOffset(40, 25))
UI.compressClipButton.TextSize = 9
setToolTip(UI.compressClipButton, "Compress clip to 80% duration. All keys and review markers retime together; undoable.")
UI.stretchClipButton = text(UI.timeline, "TextButton", "+25%", UDim2.new(1, -148, 0, 156), UDim2.fromOffset(40, 25))
UI.stretchClipButton.TextSize = 9
setToolTip(UI.stretchClipButton, "Stretch clip to 125% duration. All keys and review markers retime together; undoable.")

-- Keep editing panels outside the camera surface and share one inspector slot.
UI.inspector = Instance.new("ScrollingFrame")
UI.inspector.Name = "AnimationInspector"
UI.inspector.BackgroundColor3 = COLORS.surface
UI.inspector.BorderSizePixel = 0
UI.inspector.Active = true
UI.inspector.ScrollBarThickness = 4
UI.inspector.ScrollBarImageColor3 = COLORS.border
UI.inspector.CanvasSize = UDim2.fromOffset(0, 406)
UI.inspector.Visible = false
UI.inspector.Parent = UI.editor
UI.inspectorHeader = Instance.new("Frame")
UI.inspectorHeader.Name = "AnimationInspectorHeader"
UI.inspectorHeader.BackgroundColor3 = COLORS.surface
UI.inspectorHeader.BorderSizePixel = 0
UI.inspectorHeader.Active = true
UI.inspectorHeader.Visible = false
UI.inspectorHeader.Parent = UI.editor
UI.inspectorTitle = text(UI.inspectorHeader, "TextLabel", "INSPECTOR", UDim2.fromOffset(12, 5), UDim2.new(1, -56, 0, 26))
UI.inspectorTitle.BackgroundTransparency = 1
UI.inspectorTitle.TextColor3 = COLORS.muted
UI.inspectorTitle.TextXAlignment = Enum.TextXAlignment.Left
UI.inspectorTitle.TextSize = 12
UI.inspectorCloseButton = text(UI.inspectorHeader, "TextButton", "×", UDim2.new(1, -38, 0, 5), UDim2.fromOffset(26, 26))
UI.inspectorCloseButton.Name = "CloseAnimationInspector"
setToolTip(UI.inspectorCloseButton, "Close this inspector without changing your animation or selection")
UI.settingsPanel = Instance.new("Frame")
UI.settingsPanel.Name = "AnimationSettingsPanel"
UI.settingsPanel.Size = UDim2.fromOffset(290, 350)
UI.settingsPanel.BackgroundColor3 = COLORS.surface
UI.settingsPanel.BorderSizePixel = 0
UI.settingsPanel.Visible = false
UI.settingsPanel.Active = true
UI.settingsTitle = text(UI.settingsPanel, "TextLabel", "PREVIEW & TIMING", UDim2.fromOffset(10, 8), UDim2.new(1, -20, 0, 24))
UI.settingsTitle.BackgroundTransparency = 1
UI.settingsTitle.TextXAlignment = Enum.TextXAlignment.Left
UI.settingsTitle.Font = FONTS.headingMedium
UI.settingsTitle.TextSize = 14
UI.settingsControls = { UI.onionSkinButton, UI.transitionLoopButton, UI.snapToggleButton, UI.frameRateButton, UI.saveViewButton, UI.restoreViewButton,
    UI.setRangeInButton, UI.setRangeOutButton, UI.clearPlaybackRangeButton, UI.playbackRangeLabel, UI.rangeInLabel, UI.rangeInBox,
    UI.rangeOutLabel, UI.rangeOutBox, UI.reviewMarkerNameBox }
for index, control in UI.settingsControls do
    control.Parent = UI.settingsPanel
    control.TextSize = 12
    control.TextWrapped = false
    if index <= 9 then
        control.Position = UDim2.new((index - 1) % 2 * 0.5, 10, 0, 42 + math.floor((index - 1) / 2) * 36)
        control.Size = UDim2.new(0.5, -15, 0, 30)
    end
end
UI.playbackRangeLabel.Position = UDim2.fromOffset(10, 226)
UI.playbackRangeLabel.Size = UDim2.new(1, -20, 0, 24)
UI.rangeInLabel.Position = UDim2.fromOffset(10, 258)
UI.rangeInBox.Position = UDim2.fromOffset(38, 258)
UI.rangeOutLabel.Position = UDim2.fromOffset(142, 258)
UI.rangeOutBox.Position = UDim2.fromOffset(182, 258)
UI.reviewMarkerNameBox.Position = UDim2.fromOffset(10, 298)
UI.reviewMarkerNameBox.Size = UDim2.new(1, -20, 0, 30)
UI.settingsToggleButton = text(UI.viewport, "TextButton", "Settings", UDim2.fromOffset(12, 64), UDim2.fromOffset(100, 28))
UI.settingsToggleButton.Name = "AnimationSettingsToggle"
UI.settingsToggleButton.TextSize = 13
UI.frameRigButton.Position = UDim2.fromOffset(118, 64)
UI.frameRigButton.Size = UDim2.fromOffset(88, 28)
UI.frameRigButton.TextSize = 13
UI.gizmoToolbar.Position = UDim2.fromOffset(12, 100)
UI.gizmoToolbar.Size = UDim2.fromOffset(284, 32)
UI.curveToggleButton.Position = UDim2.fromOffset(12, 170)
UI.curveToggleButton.Size = UDim2.fromOffset(96, 28)
UI.curveToggleButton.TextSize = 13
UI.layersToggleButton.Position = UDim2.fromOffset(114, 170)
UI.layersToggleButton.Size = UDim2.fromOffset(96, 28)
UI.layersToggleButton.Text = "Layers"
UI.layersToggleButton.TextSize = 13
UI.viewportHint.Size = UDim2.new(1, -128, 0, 46)
UI.viewportHint.TextWrapped = false
UI.viewportHint.TextTruncate = Enum.TextTruncate.AtEnd
UI.inspectorPanels = { UI.keyEditor, UI.layerPanel, UI.curvePanel, UI.poseLibraryPanel, UI.settingsPanel }
UI.curveToggleButton.Text = "EASING"
UI.curveTitle.Text = "SEGMENT EASING"
setToolTip(UI.curveToggleButton, "Inspect segment easing; Bézier handles edit normalized pose progress, not individual XYZ channels")
for _, panel in UI.inspectorPanels do
    panel.Parent = UI.inspector
    panel.AnchorPoint = Vector2.new(0, 0)
    panel.Position = UDim2.fromOffset(10, 10)
    panel.Size = UDim2.new(1, -20, 0, panel == UI.layerPanel and 386 or panel == UI.curvePanel and 254 or panel == UI.settingsPanel and 350 or 320)
    panel.Active = true
end
UI.timelineHeight = 230
UI.timelineResizeHandle = Instance.new("TextButton")
UI.timelineResizeHandle.Name = "TimelineResizeHandle"
UI.timelineResizeHandle.Text = "•••"
UI.timelineResizeHandle.TextColor3 = COLORS.muted
UI.timelineResizeHandle.BackgroundColor3 = COLORS.surface
UI.timelineResizeHandle.BorderSizePixel = 0
UI.timelineResizeHandle.ZIndex = 15
UI.timelineResizeHandle.Parent = UI.editor
setToolTip(UI.timelineResizeHandle, "Drag to resize the timeline")
UI.timelineTransport = Instance.new("Frame")
UI.timelineTransport.Name = "TimelineTransport"
UI.timelineTransport.BackgroundTransparency = 1
UI.timelineTransport.Position = UDim2.new(0, 0, 1, -34)
UI.timelineTransport.Size = UDim2.new(1, 0, 0, 34)
UI.timelineTransport.Parent = UI.timeline
for _, control in UI.timeline:GetChildren() do
    if control:IsA("GuiObject") and control ~= UI.timelineTransport and control.Position.Y.Offset == 156 then
        control.Parent = UI.timelineTransport
        control.Position = UDim2.new(control.Position.X.Scale, control.Position.X.Offset, 0, 0)
    end
end
for index, control in { UI.addMarkerButton, UI.removeMarkerButton, UI.addEventButton, UI.removeEventButton, UI.compressClipButton, UI.stretchClipButton } do
    control.Parent = UI.settingsPanel
    control.Position = UDim2.new((index - 1) % 2 * 0.5, 10, 0, 340 + math.floor((index - 1) / 2) * 36)
    control.Size = UDim2.new(0.5, -15, 0, 30)
end
UI.settingsPanel.Size = UDim2.new(1, -20, 0, 456)
UI.status.Position = UDim2.fromOffset(10, 30)
UI.status.Size = UDim2.new(1, -20, 0, 24)
UI.timelineTransport.Position = UDim2.new(0, 0, 1, -60)
UI.timelineTransport.Size = UDim2.new(1, 0, 0, 60)
UI.layoutEditor = function()
    local height = UI.editor.AbsoluteSize and UI.editor.AbsoluteSize.Y or 660
    local width = UI.editor.AbsoluteSize and UI.editor.AbsoluteSize.X - 20 or 1000
    local compact = width < 800
    local headerOffset = compact and 32 or 0
    local minimumTimelineHeight = compact and 248 or 216
    local timelineHeight = math.clamp(UI.timelineHeight, minimumTimelineHeight, math.max(minimumTimelineHeight, math.min(460, height - 260)))
    UI.timelineHeight = timelineHeight
    UI.timeline.Position = UDim2.new(0, 10, 1, -timelineHeight - 10)
    UI.timeline.Size = UDim2.new(1, -20, 0, timelineHeight)
    UI.timelineResizeHandle.Position = UDim2.new(0, 10, 1, -timelineHeight - 20)
    UI.timelineResizeHandle.Size = UDim2.new(1, -20, 0, 8)
    UI.selectedLabel.Size = UDim2.new(1, compact and -20 or -410, 0, 20)
    for _, control in { UI.undoButton, UI.redoButton, UI.revertButton, UI.saveRevisionButton, UI.saveButton } do
        control.Position = UDim2.new(control.Position.X.Scale, control.Position.X.Offset, 0, 5 + headerOffset)
    end
    UI.ruler.Position = UDim2.fromOffset(100, 36 + headerOffset)
    UI.ruler.Size = UDim2.new(1, -112, 1, -104 - headerOffset)
    UI.timelineHint.Position = UDim2.fromOffset(10, 36 + headerOffset)
    UI.timelineFitButton.Position = UDim2.fromOffset(48, 36 + headerOffset)
    UI.timelineResetZoomButton.Position = UDim2.fromOffset(74, 36 + headerOffset)
    UI.trackNames.Position = UDim2.fromOffset(10, 56 + headerOffset)
    UI.trackNames.Size = UDim2.new(0, 86, 1, -124 - headerOffset)
    local hasInspector, contentHeight = false, 0
    for _, panel in UI.inspectorPanels do
        if panel.Visible then hasInspector = true; contentHeight = math.max(contentHeight, panel.Size.Y.Offset + 20) end
    end
    UI.inspector.CanvasSize = UDim2.fromOffset(0, contentHeight)
    UI.inspector.Visible = hasInspector
    UI.inspectorHeader.Visible = hasInspector
    UI.inspectorHeader.Position = UDim2.new(1, -320, 0, 10)
    UI.inspectorHeader.Size = UDim2.fromOffset(310, 36)
    UI.inspector.Position = UDim2.new(1, -320, 0, 46)
    UI.inspector.Size = UDim2.new(0, 310, 1, -timelineHeight - 76)
    UI.viewport.Size = UDim2.new(1, hasInspector and -340 or -20, 1, -timelineHeight - 40)
end
UI.timelineResizeHandle.InputBegan:Connect(function(input)
    if input.UserInputType == Enum.UserInputType.MouseButton1 then UI.resizingTimeline = true end
end)
UI.timelineResizeConnection = UserInputService.InputChanged:Connect(function(input)
    if not widget.Enabled then UI.resizingTimeline = false; return end
    if not UI.resizingTimeline or input.UserInputType ~= Enum.UserInputType.MouseMovement then return end
    UI.timelineHeight = UI.editor.AbsolutePosition.Y + UI.editor.AbsoluteSize.Y - UI.pointerPosition().Y - 15
    UI.layoutEditor()
end)
UI.timelineResizeEndConnection = UserInputService.InputEnded:Connect(function(input)
    if input.UserInputType == Enum.UserInputType.MouseButton1 then UI.resizingTimeline = false end
end)
UI.selectInspector = function(selected)
    if UI.updatingInspector then return end
    if UI.currentInspector ~= selected then UI.inspector.CanvasPosition = Vector2.new(0, 0) end
    UI.currentInspector = selected
    UI.updatingInspector = true
    for _, panel in UI.inspectorPanels do if panel ~= selected then panel.Visible = false end end
    UI.updatingInspector = false
    UI.layoutEditor()
end
UI.inspectorCloseButton.Activated:Connect(function()
    UI.selectInspector(nil)
end)
UI.settingsToggleButton.Activated:Connect(function()
    UI.settingsPanel.Visible = not UI.settingsPanel.Visible
    if UI.settingsPanel.Visible then UI.selectInspector(UI.settingsPanel) else UI.layoutEditor() end
end)
for _, panel in UI.inspectorPanels do
    panel:GetPropertyChangedSignal("Visible"):Connect(function()
        if UI.updatingInspector then return end
        if panel.Visible then UI.selectInspector(panel) else UI.layoutEditor() end
    end)
end
UI.editorLayoutConnection = UI.editor:GetPropertyChangedSignal("AbsoluteSize"):Connect(UI.layoutEditor)
UI.layoutEditor()
UI.pointInside = function(control, point)
    if not control.Visible then return false end
    local origin, size = control.AbsolutePosition, control.AbsoluteSize
    if not origin or not size then return false end
    return point.X >= origin.X and point.Y >= origin.Y and point.X <= origin.X + size.X and point.Y <= origin.Y + size.Y
end
UI.viewportPointAvailable = function(point)
    if UI.rigSwitchModal.Visible or not UI.pointInside(UI.viewport, point) then return false end
    if UI.pointInside(UI.library, point) then return false end
    for _, control in UI.viewport:GetChildren() do
        if control:IsA("GuiObject") and control ~= UI.jointManipulator and control ~= UI.viewportHint
            and UI.pointInside(control, point) then return false end
    end
    return true
end
UI.cameraFitDistance = function(size)
    local viewSize = UI.viewport.AbsoluteSize
    local aspect = viewSize and math.max(viewSize.X, 1) / math.max(viewSize.Y, 1) or 1
    local verticalHalf = math.rad(camera.FieldOfView) / 2
    local limitingHalf = math.min(verticalHalf, math.atan(math.tan(verticalHalf) * aspect))
    local radius = math.max(size.Magnitude / 2, 1)
    return radius * 1.12 / math.sin(limitingHalf)
end

local function request(path, payload)
    local response = HttpService:RequestAsync({ Url = BASE .. path, Method = "POST", Headers = { ["Content-Type"] = "application/json", Authorization = "Bearer " .. TOKEN }, Body = HttpService:JSONEncode(payload) })
    assert(response.Success, "Bridge HTTP " .. response.StatusCode .. ": " .. response.Body)
    return HttpService:JSONDecode(response.Body)
end

local function updatePlaybackToggle(isPlaying)
    playbackToggleButton.Text = isPlaying and "■" or "▶"
    playbackToggleButton.BackgroundColor3 = isPlaying and Color3.fromRGB(92, 47, 62) or COLORS.accentSoft
    setToolTip(playbackToggleButton, isPlaying and "Stop viewport playback" or "Play the loaded animation")
end
updatePlaybackToggle(false)
local refreshTimeline, refreshCurveGraph, selectKey, showPose, stopEditorPlayback, updateKeySelectionAppearance

local function selectedAnimationLayer()
    if not currentRecipe or not activeLayerId then return nil end
    for _, layer in currentRecipe.layers or {} do if layer.id == activeLayerId then return layer end end
    activeLayerId = nil
    return nil
end
local function editableTracks()
    local layer = selectedAnimationLayer()
    return layer and layer.tracks or currentRecipe and currentRecipe.tracks or {}
end
local function allRecipeTracks()
    local tracks = {}
    if not currentRecipe then return tracks end
    for _, track in currentRecipe.tracks do table.insert(tracks, track) end
    for _, layer in currentRecipe.layers or {} do for _, track in layer.tracks do table.insert(tracks, track) end end
    if currentRecipe.rootMotion then table.insert(tracks, currentRecipe.rootMotion) end
    return tracks
end
local refreshLayerPanel
local function previewCurrentLayerState()
    stopEditorPlayback()
    refreshTimeline()
    showPose(tonumber(UI.scrubber.Text) or 0)
end
local function selectAnimationLayer(layerId)
    activeLayerId = layerId
    selectedKeyTrackIndex, selectedKeyIndex = nil, nil
    table.clear(selectedKeys)
    UI.keyEditor.Visible = false
    UI.layerPanel.Visible = true
    refreshLayerPanel()
    previewCurrentLayerState()
    local layer = selectedAnimationLayer()
    if layer and layer.blendMode == "Additive" and setGizmoMode then setGizmoMode("Select") end
    UI.status.Text = layer and ("Editing layer · " .. layer.name .. " · " .. layer.blendMode) or "Editing the base animation tracks."
end
refreshLayerPanel = function()
    if not UI.layerList then return end
    for _, child in UI.layerList:GetChildren() do child:Destroy() end
    for _, child in UI.layerBaseTrackList:GetChildren() do child:Destroy() end
    local recipe = currentRecipe
    local layers = recipe and recipe.layers or {}
    local active = selectedAnimationLayer()
    UI.layersToggleButton.Visible = recipe ~= nil
    UI.layerPanelTitle.Text = string.format("POSE LAYERS  ·  %d/32", #layers)
    UI.layerBaseButton.BackgroundColor3 = active and COLORS.control or COLORS.accentSoft
    UI.layerModeButton.Active = active ~= nil
    UI.layerEnabledButton.Active = active ~= nil
    UI.layerWeightBox.TextEditable = active ~= nil
    UI.layerMoveUpButton.Active = active ~= nil
    UI.layerMoveDownButton.Active = active ~= nil
    UI.layerDeleteButton.Active = active ~= nil
    UI.layerWeightBox.TextTransparency = active and 0 or 0.5
    UI.layerWeightBox.Text = active and string.format("%d", math.floor(active.weight * 100 + 0.5)) or "—"
    UI.layerModeButton.Text = active and ("Mode · " .. active.blendMode) or "Mode · —"
    UI.layerEnabledButton.Text = active and (active.enabled and "Enabled · ON" or "Enabled · OFF") or "Enabled · —"
    UI.layerEnabledButton.BackgroundColor3 = active and active.enabled and COLORS.accentSoft or COLORS.control
    UI.layerTracksTitle.Text = active and "ADD BASE JOINT TRACKS TO THIS LAYER" or "SELECT A LAYER TO ADD TRACKS"
    setToolTip(UI.layerTracksTitle, active and active.blendMode == "Additive" and "Added tracks start from neutral zero offsets. Edit their values in the numeric pose fields; viewport transform gizmos target absolute poses." or "Override layers start from the base joint poses and can be edited with viewport transform tools.")
    local y = 4
    for index, layer in layers do
        local row = text(UI.layerList, "TextButton", string.format("%02d  %s  ·  %s  ·  %d%%  ·  %s", index, layer.name, layer.blendMode, math.floor(layer.weight * 100 + 0.5), layer.enabled and "ON" or "OFF"), UDim2.fromOffset(4, y), UDim2.new(1, -8, 0, 27))
        row.Name = "AnimationLayer_" .. layer.id
        row.TextSize = 9
        row.TextXAlignment = Enum.TextXAlignment.Left
        row.TextTruncate = Enum.TextTruncate.AtEnd
        row.BackgroundColor3 = layer.id == activeLayerId and COLORS.accentSoft or COLORS.control
        row.ZIndex = 12
        row.Activated:Connect(function() selectAnimationLayer(layer.id) end)
        y += 30
    end
    UI.layerList.CanvasSize = UDim2.fromOffset(0, y)
    y = 3
    if active then
        for _, baseTrack in recipe and recipe.tracks or {} do
            local exists = false
            for _, layerTrack in active.tracks do if layerTrack.joint == baseTrack.joint then exists = true; break end end
            if not exists then
                local row = text(UI.layerBaseTrackList, "TextButton", "+  " .. baseTrack.joint, UDim2.fromOffset(4, y), UDim2.new(1, -8, 0, 24))
                row.TextSize = 9
                row.TextXAlignment = Enum.TextXAlignment.Left
                row.ZIndex = 12
                row.Activated:Connect(function()
                    if not currentRecipe or not selectedAnimationLayer() then return end
                    pushUndoSnapshot()
                    local layerTrack = cloneRecipe(baseTrack)
                    if active.blendMode == "Additive" then
                        for _, key in layerTrack.keys do key.position = { 0, 0, 0 }; key.rotation = { 0, 0, 0 } end
                    end
                    table.insert(active.tracks, layerTrack)
                    activeLayerId = active.id
                    selectedKeyTrackIndex = #active.tracks
                    selectedKeyIndex = 1
                    UI.setRecipeDirty(true)
                    refreshLayerPanel()
                    previewCurrentLayerState()
                    selectKey(selectedKeyTrackIndex, selectedKeyIndex)
                    UI.status.Text = "Added " .. baseTrack.joint .. " as an independent layer track; base keys remain untouched."
                end)
                y += 27
            end
        end
    end
    UI.layerBaseTrackList.CanvasSize = UDim2.fromOffset(0, y)
    setToolTip(UI.layerPanel, active and string.format("Selected layer: %s · %s blend at %d%% opacity · applied in stack order.", active.name, active.blendMode, math.floor(active.weight * 100 + 0.5)) or "Layer output is composed over the base animation in stack order.")
end
local function createAnimationLayer(blendMode)
    if not currentRecipe then UI.status.Text = "Load an animation before creating a layer."; return end
    local layers = currentRecipe.layers or {}
    if #layers >= 32 then UI.status.Text = "An animation can contain at most 32 layers."; return end
    pushUndoSnapshot()
    currentRecipe.layers = layers
    local layer = { id = HttpService:GenerateGUID(false), name = blendMode .. " " .. tostring(#layers + 1), blendMode = blendMode, weight = 1, enabled = true, tracks = {} }
    table.insert(layers, layer)
    UI.setRecipeDirty(true)
    activeLayerId = layer.id
    selectedKeyTrackIndex, selectedKeyIndex = nil, nil
    table.clear(selectedKeys)
    if blendMode == "Additive" and setGizmoMode then setGizmoMode("Select") end
    refreshLayerPanel()
    UI.layerPanel.Visible = true
    previewCurrentLayerState()
    UI.status.Text = "Created an empty " .. blendMode .. " layer. Add base joint tracks below; edits stay separate from the base."
end
UI.layersToggleButton.Activated:Connect(function()
    UI.layerPanel.Visible = not UI.layerPanel.Visible
    if UI.layerPanel.Visible then refreshLayerPanel() end
end)
UI.layerCloseButton.Activated:Connect(function() UI.layerPanel.Visible = false end)
UI.layerBaseButton.Activated:Connect(function() selectAnimationLayer(nil) end)
UI.layerOverrideButton.Activated:Connect(function() createAnimationLayer("Override") end)
UI.layerAdditiveButton.Activated:Connect(function() createAnimationLayer("Additive") end)
UI.layerModeButton.Activated:Connect(function()
    local layer = selectedAnimationLayer()
    if not layer then return end
    pushUndoSnapshot()
    layer.blendMode = layer.blendMode == "Override" and "Additive" or "Override"
    UI.setRecipeDirty(true)
    refreshLayerPanel()
    previewCurrentLayerState()
end)
UI.layerEnabledButton.Activated:Connect(function()
    local layer = selectedAnimationLayer()
    if not layer then return end
    pushUndoSnapshot()
    layer.enabled = not layer.enabled
    UI.setRecipeDirty(true)
    refreshLayerPanel()
    previewCurrentLayerState()
end)
UI.layerWeightBox.FocusLost:Connect(function()
    local layer = selectedAnimationLayer()
    local value = tonumber(UI.layerWeightBox.Text)
    if not layer then return end
    if not value or value ~= value or math.abs(value) == math.huge or value < 0 or value > 100 then
        UI.layerWeightBox.Text = tostring(math.floor(layer.weight * 100 + 0.5))
        UI.status.Text = "Layer weight must be a percentage from 0 to 100."
        return
    end
    if math.abs(layer.weight - value / 100) < 0.00001 then return end
    pushUndoSnapshot()
    layer.weight = value / 100
    UI.setRecipeDirty(true)
    refreshLayerPanel()
    previewCurrentLayerState()
end)
local function moveSelectedLayer(direction)
    local layer = selectedAnimationLayer()
    if not layer then return end
    local index = table.find(currentRecipe.layers, layer)
    local destination = index and index + direction
    if not destination or destination < 1 or destination > #currentRecipe.layers then return end
    pushUndoSnapshot()
    currentRecipe.layers[index], currentRecipe.layers[destination] = currentRecipe.layers[destination], currentRecipe.layers[index]
    UI.setRecipeDirty(true)
    refreshLayerPanel()
    previewCurrentLayerState()
end
UI.layerMoveUpButton.Activated:Connect(function() moveSelectedLayer(-1) end)
UI.layerMoveDownButton.Activated:Connect(function() moveSelectedLayer(1) end)
UI.layerDeleteButton.Activated:Connect(function()
    local layer = selectedAnimationLayer()
    if not layer then return end
    pushUndoSnapshot()
    local index = table.find(currentRecipe.layers, layer)
    if index then table.remove(currentRecipe.layers, index) end
    activeLayerId = nil
    selectedKeyTrackIndex, selectedKeyIndex = nil, nil
    table.clear(selectedKeys)
    UI.keyEditor.Visible = false
    UI.setRecipeDirty(true)
    refreshLayerPanel()
    previewCurrentLayerState()
    UI.status.Text = "Deleted layer " .. layer.name .. "; the base animation was not altered. Undo is available."
end)

local function updateConnectionControls()
    UI.title.Visible = libraryExpanded
    UI.connectionLabel.Visible = libraryExpanded
    if libraryExpanded then
        UI.connectButton.Position = UDim2.new(1, -82, 0, 18)
        UI.connectButton.Size = UDim2.fromOffset(70, 28)
        UI.connectButton.Text = connected and "Disconnect" or "Connect"
    else
        UI.connectButton.Position = UDim2.fromOffset(11, 40)
        UI.connectButton.Size = UDim2.fromOffset(30, 20)
        UI.connectButton.Text = connected and "●" or "↻"
    end
    UI.connectButton.BackgroundColor3 = connected and COLORS.accentSoft or COLORS.control
    setToolTip(UI.connectButton, connected and "Disconnect from Motion Tools" or "Connect to Motion Tools")
end

local function setLibraryExpanded(expanded)
    libraryExpanded = expanded or libraryPinned
    if libraryTween then libraryTween:Cancel() end
    local width = libraryExpanded and libraryWidth or railWidth
    local tweenInfo = TweenInfo.new(0.22, Enum.EasingStyle.Quint, Enum.EasingDirection.Out)
    libraryTween = TweenService:Create(UI.library, tweenInfo, { Size = UDim2.new(0, width, 1, 0) })
    libraryTween:Play()
    local reservedWidth = libraryPinned and libraryWidth or railWidth
    local editorTween = TweenService:Create(UI.editor, tweenInfo, {
        Position = UDim2.new(0, reservedWidth, 0, 0),
        Size = UDim2.new(1, -reservedWidth, 1, 0),
    })
    editorTween:Play()
    updateConnectionControls()
    for _, control in { UI.rigHeader, UI.createRigButton, UI.rigOptionsButton, UI.rigSearchBox, UI.rigList, UI.workflowHint, UI.animationHeader, UI.refreshButton, UI.animationSearchBox, UI.revisionFilterButton, UI.dropdown } do
        control.Visible = libraryExpanded
    end
    UI.pinButton.Text = libraryPinned and "›" or "‹"
    UI.pinButton.BackgroundColor3 = libraryPinned and COLORS.accentSoft or COLORS.control
end
setLibraryExpanded(false)

local selectedAssetId = plugin:GetSetting("MotionSelectedAnimation")
local selectedAssetIsEphemeral = false
local selectedAssetParentId = nil
local selectedSourceRigProfile = nil
local selectedAssetFingerprint = nil
local ephemeralBaseRecipe = nil
local libraryBusy = false
local refreshLibrary
local draggingKey
local curveDrag
local availableAnimations = {}
local showAllRevisions = false
UI.updateDraftState = function()
    local label, color, background, detail
    if not currentRecipe or not selectedAssetId then
        label, color, background, detail = "NO CLIP", COLORS.muted, COLORS.raised, "No animation recipe is open in the viewport."
    elseif recipeDirty and selectedAssetIsEphemeral then
        label, color, background, detail = "CANDIDATE · EDITED", COLORS.accent, COLORS.accentSoft, "This unsaved candidate has additional local edits. Save Revision creates a local child/revision."
    elseif recipeDirty then
        label, color, background, detail = "UNSAVED EDITS", COLORS.accent, COLORS.accentSoft, "The open saved animation has local edits that are not saved."
    elseif selectedAssetIsEphemeral then
        label, color, background, detail = "UNSAVED CANDIDATE", COLORS.accent, COLORS.accentSoft, "This exact AI candidate is open for review and has not been committed as a local revision."
    else
        label, color, background, detail = "SAVED REVISION", COLORS.muted, COLORS.raised, "The open animation matches its saved local revision."
    end
    UI.draftStateBadge.Text = label
    UI.draftStateBadge.TextColor3 = color
    UI.draftStateBadge.BackgroundColor3 = background
    setToolTip(UI.draftStateBadge, detail)
end
UI.setRecipeDirty = function(dirty)
    recipeDirty = dirty
    if UI.updateDraftState then UI.updateDraftState() end
end
UI.updateDraftState()
local renderAnimationLibrary
local function clearEditorPreviewEffects()
    local state = editorPreviewEffects
    editorPreviewEffects = nil
    if not state then return end
    for _, active in state.active do
        if active.attachment and active.attachment.Parent then active.attachment:Destroy() end
    end
    table.clear(state.active)
end
local function updateEditorPreviewEffects(time, delta)
    local state = editorPreviewEffects
    if not state or not viewportClone then return end
    state.elapsed += delta * playbackSpeed
    local cycle = previewLoop and currentRecipe and math.floor(state.elapsed / currentRecipe.duration) or 0
    for index, cue in state.cues do
        if cue.time <= time and state.firedCycle[index] ~= cycle then
            state.firedCycle[index] = cycle
            local attachment, controller = Authoring.effect(cue.partInstance, cue.recipe, true)
            table.insert(state.active, { attachment = attachment, controller = controller, startedAt = state.elapsed, lifetime = cue.recipe.lifetime })
        end
    end
    for index = #state.active, 1, -1 do
        local active = state.active[index]
        local age = state.elapsed - active.startedAt
        if active.controller then active.controller.update(age) end
        if age >= active.lifetime or not active.attachment.Parent then
            if active.attachment.Parent then active.attachment:Destroy() end
            table.remove(state.active, index)
        end
    end
    if state.stopAfter and state.elapsed >= state.stopAfter then stopEditorPlayback() end
end
stopEditorPlayback = function()
    if playbackConnection then playbackConnection:Disconnect(); playbackConnection = nil end
    clearEditorPreviewEffects()
    updatePlaybackToggle(false)
end
ikCandidatePreview.clear = function()
    if ikCandidatePreview.connection then ikCandidatePreview.connection:Disconnect(); ikCandidatePreview.connection = nil end
    if ikCandidatePreview.model then ikCandidatePreview.model:Destroy(); ikCandidatePreview.model = nil end
    if ikCandidatePreview.targetFolder then ikCandidatePreview.targetFolder:Destroy(); ikCandidatePreview.targetFolder = nil end
    ikCandidatePreview.targets = nil
    ikCandidatePreview.recipe, ikCandidatePreview.fingerprint = nil, nil
    UI.candidatePreviewBanner.Visible = false
end
ikCandidatePreview.show = function(payload)
    assert(previewRigModel and viewportClone, "Load the target rig in the Motion Tools viewport before showing an IK candidate.")
    assert(payload.recipe and payload.recipe.kind == "animation", "Expected a candidate animation recipe.")
    local activeRig = Rig.active()
    assert(activeRig and Rig.id(activeRig) == payload.rigId, "Select the candidate's target rig in the Motion Tools Rig Library.")
    assert(not payload.rigSignature or Rig.signature(activeRig) == payload.rigSignature, "The candidate rig topology changed. Run a new coordinated IK preview.")
    assert(type(payload.candidateFingerprint) == "string" and #payload.candidateFingerprint == 64, "A valid coordinated IK candidate fingerprint is required.")
    ikCandidatePreview.clear()
    stopEditorPlayback()
    local ghost = Preview.copy(previewRigModel)
    ghost.Name = "MotionTools_IKCandidate_VisualOnly"
    ghost.Parent = world
    local _, nodes, tracks = Authoring.tracks(ghost, payload.recipe, {})
    ikCandidatePreview.model, ikCandidatePreview.recipe = ghost, cloneRecipe(payload.recipe)
    ikCandidatePreview.fingerprint = payload.candidateFingerprint
    ikCandidatePreview.targets = {}
    for _, part in ghost:GetDescendants() do
        if part:IsA("BasePart") then
            part.CanCollide, part.CanTouch, part.CanQuery = false, false, false
            part.Transparency = math.max(part.Transparency, 0.48)
        end
    end
    local highlight = Instance.new("Highlight")
    highlight.Name = "IKCandidateHighlight"
    highlight.Adornee = ghost
    highlight.FillColor = Color3.fromRGB(42, 211, 255)
    highlight.FillTransparency = 0.82
    highlight.OutlineColor = Color3.fromRGB(66, 224, 255)
    highlight.OutlineTransparency = 0.08
    highlight.DepthMode = Enum.HighlightDepthMode.AlwaysOnTop
    highlight.Parent = ghost
    if type(payload.targets) == "table" and #payload.targets > 0 then
        local targetFolder = Instance.new("Folder")
        targetFolder.Name = "MotionTools_IKRequestedTargets_VisualOnly"
        targetFolder.Parent = world
        ikCandidatePreview.targetFolder = targetFolder
        for _, target in payload.targets do
            if type(target) == "table" and type(target.limb) == "string"
                and type(target.startTime) == "number" and type(target.endTime) == "number"
                and target.startTime <= target.endTime
                and (type(target.targetWorldPosition) == "table" or type(target.targetWorldPath) == "table") then
                local marker = Instance.new("Part")
                marker.Name = "RequestedTarget_" .. target.limb
                marker.Shape = Enum.PartType.Ball
                marker.Size = Vector3.new(0.3, 0.3, 0.3)
                marker.Anchored = true
                marker.CanCollide, marker.CanTouch, marker.CanQuery = false, false, false
                marker.Material = Enum.Material.Neon
                marker.Color = Color3.fromRGB(255, 190, 72)
                marker.Parent = targetFolder
                local billboard = Instance.new("BillboardGui")
                billboard.Name = "RequestedTargetLabel"
                billboard.Adornee = marker
                billboard.AlwaysOnTop = true
                billboard.LightInfluence = 0
                billboard.Size = UDim2.fromOffset(132, 22)
                billboard.StudsOffset = Vector3.new(0, 0.32, 0)
                billboard.Parent = marker
                local label = Instance.new("TextLabel")
                label.Name = "Label"
                label.Size = UDim2.fromScale(1, 1)
                label.BackgroundColor3 = Color3.fromRGB(12, 18, 28)
                label.BackgroundTransparency = 0.12
                label.BorderSizePixel = 0
                label.Font = FONTS.data
                label.TextSize = 10
                label.TextColor3 = marker.Color
                label.Text = string.upper(target.limb) .. " TARGET"
                label.Parent = billboard
                table.insert(ikCandidatePreview.targets, { data = target, part = marker, billboard = billboard })
            end
        end
    end
    local duration = ikCandidatePreview.recipe.duration
    local elapsed = math.clamp(payload.time or 0, 0, duration)
    local function updateTargetMarkers(time)
        for _, entry in ikCandidatePreview.targets do
            local target, marker = entry.data, entry.part
            local active = time >= target.startTime and time <= target.endTime
            marker.Transparency = active and 0 or 1
            entry.billboard.Enabled = active
            if active then
                local position
                if type(target.targetWorldPath) == "table" then
                    position = IKContact.targetAt(target.targetWorldPath, time, target.targetPathInterpolation)
                    local offset = target.offset or { 0, 0, 0 }
                    marker.Position = Vector3.new(position[1] + offset[1], position[2] + offset[2], position[3] + offset[3])
                else
                    local fixed = target.targetWorldPosition
                    marker.Position = Vector3.new(fixed[1], fixed[2], fixed[3])
                end
            end
        end
    end
    local function applyCandidatePose(time)
        local safeTime = math.clamp(time, 0, duration)
        Authoring.apply(nodes, tracks, safeTime)
        updateTargetMarkers(safeTime)
        UI.candidatePreviewLabel.Text = #ikCandidatePreview.targets > 0
            and string.format("CYAN · SOLVED   AMBER · TARGET   %.2fs", safeTime)
            or string.format("IK CANDIDATE  ·  VISUAL ONLY  ·  %.2fs", safeTime)
    end
    applyCandidatePose(elapsed)
    UI.candidatePreviewBanner.Visible = true
    if payload.play then
        ikCandidatePreview.connection = RunService.Heartbeat:Connect(function(delta)
            if not widget.Enabled or ikCandidatePreview.model ~= ghost or not ghost.Parent then ikCandidatePreview.clear(); return end
            elapsed += delta * (payload.playbackSpeed or 1)
            if elapsed >= duration then
                if payload.loop then elapsed %= duration else elapsed = duration end
            end
            local ok, err = pcall(applyCandidatePose, elapsed)
            if not ok then
                UI.status.Text = "Could not preview IK candidate: " .. tostring(err)
                ikCandidatePreview.clear()
                return
            end
            if elapsed >= duration and not payload.loop and ikCandidatePreview.connection then
                ikCandidatePreview.connection:Disconnect()
                ikCandidatePreview.connection = nil
            end
        end)
    end
    UI.status.Text = payload.play and "Playing the coordinated IK candidate as a cyan visual-only ghost. The editable animation is unchanged." or "Showing the coordinated IK candidate as a cyan visual-only ghost. The editable animation is unchanged."
    return { shown = true, visualOnly = true, candidateFingerprint = payload.candidateFingerprint, time = elapsed, playing = payload.play == true }
end
local function loadViewportRig(model)
    ikCandidatePreview.clear()
    if viewportClone then viewportClone:Destroy(); viewportClone = nil end
    viewportCameraBookmark = nil
    world:ClearAllChildren()
    local clone = Preview.copy(model)
    clone.Name = "MotionEditorRig"
    clone.Parent = world
    viewportClone = clone
    if refreshIKEffectors then refreshIKEffectors() end
    local bounds, size = clone:GetBoundingBox()
    local center = bounds.Position
    local radius = math.max(size.X, size.Y, size.Z, 2)
    orbitFocus = center
    orbitYaw, orbitPitch = math.rad(25), math.rad(8)
    minimumZoom, maximumZoom = radius * 1.35, radius * 8
    orbitDistance = math.clamp(UI.cameraFitDistance(size), minimumZoom, maximumZoom)
    local floor = Instance.new("Part")
    floor.Name = "PreviewStage"
    floor.Anchored = true
    floor.CanCollide = false
    floor.CanTouch = false
    floor.CanQuery = false
    floor.Material = Enum.Material.SmoothPlastic
    floor.Color = Color3.fromRGB(8, 14, 23)
    floor.Size = Vector3.new(math.max(radius * 8, 32), 0.12, math.max(radius * 8, 32))
    floor.CFrame = CFrame.new(center.X, center.Y - size.Y / 2 - 0.06, center.Z)
    floor.Parent = world
    local gridFolder = Instance.new("Folder")
    gridFolder.Name = "PreviewGrid"
    gridFolder.Parent = world
    local gridExtent = math.max(radius * 4, 16)
    local gridSpacing = math.max(radius * 0.4, 1.5)
    local lineCount = math.floor(gridExtent / gridSpacing)
    for index = -lineCount, lineCount do
        local offset = index * gridSpacing
        for axis = 1, 2 do
            local line = Instance.new("Part")
            line.Name = "GridLine"
            line.Anchored = true
            line.CanCollide = false
            line.CanTouch = false
            line.CanQuery = false
            line.Material = Enum.Material.Neon
            line.Transparency = index == 0 and 0.42 or 0.94
            line.Color = index == 0 and COLORS.accent or Color3.fromRGB(34, 71, 91)
            line.Size = axis == 1 and Vector3.new(gridExtent * 2, 0.015, 0.025) or Vector3.new(0.025, 0.015, gridExtent * 2)
            line.CFrame = CFrame.new(center.X + (axis == 1 and 0 or offset), center.Y - size.Y / 2 + 0.012, center.Z + (axis == 1 and offset or 0))
            line.Parent = gridFolder
        end
    end
    local cameraOffset = CFrame.fromOrientation(orbitPitch, orbitYaw, 0).LookVector * -orbitDistance
    camera.CFrame = CFrame.lookAt(orbitFocus + cameraOffset, orbitFocus)
    updateViewportHud()
    UI.viewportHint.Visible = true
end
local function frameViewportRig()
    if not viewportClone then
        UI.status.Text = "Load a rig before framing the viewport."
        return
    end
    local bounds, size = viewportClone:GetBoundingBox()
    local center = bounds.Position
    local radius = math.max(size.X, size.Y, size.Z, 2)
    orbitFocus = center
    minimumZoom, maximumZoom = radius * 1.35, radius * 8
    orbitDistance = math.clamp(UI.cameraFitDistance(size), minimumZoom, maximumZoom)
    local cameraOffset = CFrame.fromOrientation(orbitPitch, orbitYaw, 0).LookVector * -orbitDistance
    camera.CFrame = CFrame.lookAt(orbitFocus + cameraOffset, orbitFocus)
    updateViewportHud()
    UI.status.Text = "Viewport centered and framed on the loaded rig."
end
UI.frameRigButton.MouseButton1Click:Connect(frameViewportRig)
UI.saveViewButton.MouseButton1Click:Connect(function()
    if not viewportClone then UI.status.Text = "Load a rig before saving a viewport view."; return end
    viewportCameraBookmark = {
        focus = orbitFocus,
        yaw = orbitYaw,
        pitch = orbitPitch,
        distance = orbitDistance,
        fieldOfView = camera.FieldOfView,
        cframe = camera.CFrame,
    }
    UI.status.Text = "Viewport angle saved for this rig and Studio session."
end)
UI.restoreViewButton.MouseButton1Click:Connect(function()
    if not viewportClone then UI.status.Text = "Load a rig before restoring a viewport view."; return end
    if not viewportCameraBookmark then UI.status.Text = "No saved viewport view for this rig yet. Use Save View first."; return end
    orbitFocus = viewportCameraBookmark.focus
    orbitYaw, orbitPitch = viewportCameraBookmark.yaw, viewportCameraBookmark.pitch
    orbitDistance = viewportCameraBookmark.distance
    camera.FieldOfView = viewportCameraBookmark.fieldOfView
    camera.CFrame = viewportCameraBookmark.cframe
    updateViewportHud()
    UI.status.Text = "Saved viewport angle restored."
end)
showPose = function(time)
    if not viewportClone or not currentRecipe then return end
    local ok, err = pcall(function()
        local _, nodes, tracks = Authoring.tracks(viewportClone, currentRecipe, {})
        Authoring.apply(nodes, tracks, math.clamp(time, 0, currentRecipe.duration))
    end)
    if not ok then UI.status.Text = "Could not evaluate pose: " .. tostring(err) end
end
local function clearOnionGhosts()
    for _, ghost in onionGhosts do if ghost and ghost.Parent then ghost:Destroy() end end
    table.clear(onionGhosts)
end
local function refreshOnionSkin()
    clearOnionGhosts()
    if not onionSkinEnabled or not currentRecipe or not previewRigModel or not selectedKeyTrackIndex or not selectedKeyIndex then return end
    local selectedTrack = editableTracks()[selectedKeyTrackIndex]
    if not selectedTrack then return end
    local neighborIndices = { selectedKeyIndex - 1, selectedKeyIndex + 1 }
    local colors = { Color3.fromRGB(44, 205, 255), Color3.fromRGB(180, 126, 255) }
    for neighborPosition, keyIndex in neighborIndices do
        local neighborKey = selectedTrack.keys[keyIndex]
        if neighborKey then
            local ok, err = pcall(function()
                local ghost = Preview.copy(previewRigModel)
                ghost.Name = neighborPosition == 1 and "PreviousPoseGhost" or "NextPoseGhost"
                ghost.Parent = world
                local _, nodes, tracks = Authoring.tracks(ghost, currentRecipe, {})
                Authoring.apply(nodes, tracks, neighborKey.time)
                for _, part in ghost:GetDescendants() do
                    if part:IsA("BasePart") then part.Transparency = math.max(part.Transparency, 0.78) end
                end
                local highlight = Instance.new("Highlight")
                highlight.Name = "PoseGhostHighlight"
                highlight.Adornee = ghost
                highlight.FillColor = colors[neighborPosition]
                highlight.FillTransparency = 0.78
                highlight.OutlineColor = colors[neighborPosition]
                highlight.OutlineTransparency = 0.18
                highlight.DepthMode = Enum.HighlightDepthMode.Occluded
                highlight.Parent = ghost
                table.insert(onionGhosts, ghost)
            end)
            if not ok then
                clearOnionGhosts()
                UI.status.Text = "Could not create pose ghosts: " .. tostring(err)
                return
            end
        end
    end
end
UI.onionSkinButton.MouseButton1Click:Connect(function()
    onionSkinEnabled = not onionSkinEnabled
    UI.onionSkinButton.Text = onionSkinEnabled and "Ghosts · On" or "Ghosts · Off"
    UI.onionSkinButton.BackgroundColor3 = onionSkinEnabled and COLORS.accentSoft or COLORS.control
    refreshOnionSkin()
    if onionSkinEnabled then
        UI.status.Text = "Onion skinning shows adjacent poses on the selected joint's track."
    else
        UI.status.Text = "Pose ghost overlays hidden."
    end
end)
local function timelineViewBounds(duration)
    if not duration or duration <= 0 then return 0, 1 end
    local minimumSpan = math.min(duration, 0.05)
    local span = math.clamp(timelineViewSpan or duration, minimumSpan, duration)
    local startTime = math.clamp(timelineViewStart, 0, duration - span)
    timelineViewStart, timelineViewSpan = startTime, span
    return startTime, startTime + span
end
local function timelineTimeToAlpha(time, duration)
    local startTime, endTime = timelineViewBounds(duration)
    return (time - startTime) / math.max(endTime - startTime, 0.000001)
end
local function timelineAlphaToTime(alpha, duration)
    local startTime, endTime = timelineViewBounds(duration)
    return startTime + alpha * (endTime - startTime)
end
local function updatePlayhead(time)
    local duration = currentRecipe and currentRecipe.duration or 0
    local alpha = duration > 0 and math.clamp(timelineTimeToAlpha(time, duration), 0, 1) or 0
    UI.playhead.Position = UDim2.new(alpha, 8 - alpha * 16, 0, 0)
    UI.playhead.Size = UDim2.new(0, 2, 0, math.max(UI.trackArea.CanvasSize.Y.Offset, UI.trackArea.AbsoluteSize.Y))
    UI.scrubber.Text = string.format("%.3f", duration > 0 and math.clamp(time, 0, duration) or math.max(time, 0))
end
updateKeySelectionAppearance = function()
    for key, entry in pairs(keyMarkerByKey) do
        local marker = entry.marker
        if marker.Parent then
            local isSelected = selectedKeys[key] == true
                or selectedKeyTrackIndex == entry.trackIndex and selectedKeyIndex == entry.keyIndex
            local isSelectedTrack = selectedKeyTrackIndex == entry.trackIndex
            marker.BackgroundColor3 = isSelected and COLORS.text or (isSelectedTrack and COLORS.accentSoft or COLORS.accent)
            marker.Size = isSelected and UDim2.fromOffset(12, 12) or UDim2.fromOffset(9, 9)
        end
    end
end
refreshTimeline = function()
    table.clear(keyMarkerByKey)
    for _, child in UI.keyMarkers:GetChildren() do child:Destroy() end
    for _, child in UI.rulerTicks:GetChildren() do child:Destroy() end
    for _, child in UI.trackNames:GetChildren() do child:Destroy() end
    if not currentRecipe then
        UI.timelineHint.Text = "1.0×"
        UI.trackArea.CanvasSize = UDim2.fromOffset(0, 0)
        UI.trackNames.CanvasSize = UDim2.fromOffset(0, 0)
        updatePlayhead(0)
        return
    end
    local duration = currentRecipe.duration
    local totalKeys = 0
    local rowHeight = 26
    local viewStart, viewEnd = timelineViewBounds(duration)
    local viewSpan = viewEnd - viewStart
    UI.timelineHint.Text = string.format("%.1f×", duration / viewSpan)
    setToolTip(UI.timelineHint, string.format("View spans %.3f–%.3fs of %.3fs (%d tracks). Ctrl + wheel zooms; Shift + wheel pans.", viewStart, viewEnd, duration, #editableTracks()))
    local tickCount = math.clamp(math.ceil(viewSpan * 2), 2, 10)
    for index = 0, tickCount do
        local time = viewStart + viewSpan * index / math.max(tickCount, 1)
        local alpha = timelineTimeToAlpha(time, duration)
        local tick = Instance.new("Frame")
        tick.Name = "RulerTick_" .. tostring(index)
        tick.AnchorPoint = Vector2.new(0.5, 0)
        tick.Position = UDim2.new(alpha, 8 - alpha * 16, 0, 14)
        tick.Size = UDim2.fromOffset(1, 5)
        tick.BackgroundColor3 = COLORS.muted
        tick.BackgroundTransparency = 0.3
        tick.BorderSizePixel = 0
        tick.ZIndex = 2
        tick.Parent = UI.rulerTicks
        local label = Instance.new("TextLabel")
        label.Name = "RulerLabel_" .. tostring(index)
        label.AnchorPoint = Vector2.new(index == 0 and 0 or index == tickCount and 1 or 0.5, 0)
        label.Position = UDim2.new(alpha, 8 - alpha * 16, 0, 1)
        label.Size = UDim2.fromOffset(42, 12)
        label.BackgroundTransparency = 1
        label.Font = FONTS.data
        label.TextSize = 10
        label.TextColor3 = COLORS.muted
        label.Text = string.format("%.1f", time)
        label.TextXAlignment = index == 0 and Enum.TextXAlignment.Left or index == tickCount and Enum.TextXAlignment.Right or Enum.TextXAlignment.Center
        label.ZIndex = 2
        label.Parent = UI.rulerTicks
    end
    local function addRangeHandle(kind, time, color)
        local alpha = math.clamp(timelineTimeToAlpha(time, duration), 0, 1)
        local line = Instance.new("Frame")
        line.Name = "Range" .. kind .. "Line"
        line.AnchorPoint = Vector2.new(0.5, 0)
        line.Position = UDim2.new(alpha, 8 - alpha * 16, 0, 0)
        line.Size = UDim2.new(0, 2, 1, 0)
        line.BackgroundColor3 = color
        line.BackgroundTransparency = 0.3
        line.BorderSizePixel = 0
        line.ZIndex = 3
        line.Parent = UI.rulerTicks
        local handle = text(UI.rulerTicks, "TextButton", kind, UDim2.new(alpha, -7, 0, 13), UDim2.fromOffset(14, 14))
        handle.Name = "Range" .. kind .. "Handle"
        handle.TextSize = 8
        handle.BackgroundColor3 = color
        handle.TextColor3 = COLORS.shell
        handle.ZIndex = 7
        setToolTip(handle, string.format("Playback %s · %.3fs · drag to adjust", kind, time))
        handle.InputBegan:Connect(function(input)
            if input.UserInputType ~= Enum.UserInputType.MouseButton1 then return end
            draggingRangeHandle = kind
            stopEditorPlayback()
        end)
    end
    if playbackRangeIn then addRangeHandle("In", playbackRangeIn, COLORS.accent) end
    if playbackRangeOut then addRangeHandle("Out", playbackRangeOut, Color3.fromRGB(180, 126, 255)) end
    for markerIndex, reviewMarker in reviewMarkers do
        local alpha = math.clamp(timelineTimeToAlpha(reviewMarker.time, duration), 0, 1)
        local marker = Instance.new("TextButton")
        marker.Name = "ReviewMarker_" .. tostring(markerIndex)
        marker.AnchorPoint = Vector2.new(0.5, 0.5)
        marker.Position = UDim2.new(alpha, 8 - alpha * 16, 0, 17)
        marker.Size = UDim2.fromOffset(13, 13)
        marker.BackgroundColor3 = markerIndex == selectedReviewMarker and COLORS.text or COLORS.accent
        marker.BorderSizePixel = 0
        marker.Text = ""
        marker.AutoButtonColor = true
        marker.ZIndex = 6
        setToolTip(marker, string.format("%s · %.2fs", reviewMarker.name, reviewMarker.time))
        marker.Parent = UI.rulerTicks
        local markerCorner = Instance.new("UICorner")
        markerCorner.CornerRadius = UDim.new(1, 0)
        markerCorner.Parent = marker
        marker.MouseButton1Click:Connect(function()
            selectedReviewMarker = markerIndex
            selectedEventIndex = nil
            UI.removeEventButton.Active = false
            UI.removeEventButton.TextTransparency = 0.5
            UI.reviewMarkerNameBox.Visible = true
            UI.reviewMarkerNameBox.Text = reviewMarker.name
            UI.settingsPanel.Visible = true
            UI.selectInspector(UI.settingsPanel)
            UI.removeMarkerButton.Active = true
            UI.removeMarkerButton.TextTransparency = 0
            updatePlayhead(reviewMarker.time)
            stopEditorPlayback()
            showPose(reviewMarker.time)
            UI.status.Text = string.format("%s · %.2fs", reviewMarker.name, reviewMarker.time)
            refreshTimeline()
        end)
    end
    for trackIndex, track in editableTracks() do
        local y = (trackIndex - 1) * rowHeight
        local isSelectedTrack = selectedKeyTrackIndex == trackIndex
        local label = Instance.new("TextLabel")
        label.Name = "Joint_" .. tostring(trackIndex)
        label.Position = UDim2.fromOffset(4, y)
        label.Size = UDim2.new(1, -8, 0, rowHeight)
        label.BackgroundTransparency = 1
        label.Font = FONTS.ui
        label.TextSize = 11
        label.TextColor3 = isSelectedTrack and COLORS.accent or COLORS.muted
        label.TextXAlignment = Enum.TextXAlignment.Left
        label.TextTruncate = Enum.TextTruncate.AtEnd
        label.Text = track.joint
        setToolTip(label, isSelectedTrack and (track.joint .. " · selected track shows rotation curves: X red, Y green, Z blue, in degrees") or (track.joint .. " · select to show its rotation curves"))
        label.Parent = UI.trackNames

        local row = Instance.new("Frame")
        row.Name = "TrackRow_" .. tostring(trackIndex)
        row.Position = UDim2.fromOffset(0, y)
        row.Size = UDim2.new(1, 0, 0, rowHeight)
        row.BackgroundColor3 = isSelectedTrack and COLORS.accentSoft or (trackIndex % 2 == 0 and COLORS.raised or COLORS.control)
        row.BackgroundTransparency = isSelectedTrack and 0.3 or 0.6
        row.BorderSizePixel = 0
        row.Parent = UI.keyMarkers
        local line = Instance.new("Frame")
        line.Name = "TrackLine"
        line.AnchorPoint = Vector2.new(0.5, 0.5)
        line.Position = UDim2.new(0.5, 0, 0.5, 0)
        line.Size = UDim2.new(1, -16, 0, 1)
        line.BackgroundColor3 = isSelectedTrack and COLORS.accent or COLORS.border
        line.BackgroundTransparency = isSelectedTrack and 0.4 or 0.62
        line.BorderSizePixel = 0
        line.Parent = row

        if isSelectedTrack then
            local axisColors = {
                Color3.fromRGB(244, 104, 113),
                Color3.fromRGB(116, 224, 151),
                Color3.fromRGB(108, 169, 255),
            }
            local maximumAngle = 0
            for _, key in track.keys do
                for axis = 1, 3 do maximumAngle = math.max(maximumAngle, math.abs(key.rotation[axis])) end
            end
            if maximumAngle > 0 then
                local graphCenter = rowHeight / 2
                local graphAmplitude = rowHeight / 2 - 4
                local graphPadding = 8
                for axis = 1, 3 do
                    for keyIndex = 1, #track.keys - 1 do
                        local leftKey, rightKey = track.keys[keyIndex], track.keys[keyIndex + 1]
                        local leftAlpha = math.clamp(timelineTimeToAlpha(leftKey.time, duration), 0, 1)
                        local rightAlpha = math.clamp(timelineTimeToAlpha(rightKey.time, duration), 0, 1)
                        local graphWidth = math.max(row.AbsoluteSize.X - graphPadding * 2, 1)
                        local previousX = graphPadding + leftAlpha * graphWidth
                        local previousY = graphCenter - leftKey.rotation[axis] / maximumAngle * graphAmplitude
                        for sampleIndex = 1, 10 do
                            local sampleAlpha = sampleIndex / 10
                            local timelineAlpha = leftAlpha + (rightAlpha - leftAlpha) * sampleAlpha
                            local easedAlpha = Authoring.easeAlpha(leftKey.easingStyle or "Linear", leftKey.easingDirection or "Out", sampleAlpha, leftKey.curve)
                            local value = leftKey.rotation[axis] + (rightKey.rotation[axis] - leftKey.rotation[axis]) * easedAlpha
                            local nextX = graphPadding + timelineAlpha * graphWidth
                            local nextY = math.clamp(graphCenter - value / maximumAngle * graphAmplitude, 3, rowHeight - 3)
                            local deltaX, deltaY = nextX - previousX, nextY - previousY
                            local curveSegment = Instance.new("Frame")
                            curveSegment.Name = "RotationCurve_" .. tostring(axis) .. "_" .. tostring(keyIndex) .. "_" .. tostring(sampleIndex)
                            curveSegment.AnchorPoint = Vector2.new(0, 0.5)
                            curveSegment.Position = UDim2.fromOffset(previousX, previousY)
                            curveSegment.Size = UDim2.fromOffset(math.max(math.sqrt(deltaX * deltaX + deltaY * deltaY), 1), 1.5)
                            curveSegment.Rotation = math.deg(math.atan2(deltaY, deltaX))
                            curveSegment.BackgroundColor3 = axisColors[axis]
                            curveSegment.BackgroundTransparency = 0.2
                            curveSegment.BorderSizePixel = 0
                            curveSegment.ZIndex = 2
                            curveSegment.Parent = row
                            if sampleIndex == 1 then
                                setToolTip(curveSegment, string.format("%s · Rotation %s · %.2f° → %.2f°", leftKey.easingStyle or "Linear", ({ "X", "Y", "Z" })[axis], leftKey.rotation[axis], rightKey.rotation[axis]))
                            end
                            previousX, previousY = nextX, nextY
                        end
                    end
                end
            end
        end

        for keyIndex, key in track.keys do
            totalKeys += 1
            local alpha = math.clamp(timelineTimeToAlpha(key.time, duration), 0, 1)
            local marker = Instance.new("TextButton")
            marker.Name = string.format("Key_%d_%d", trackIndex, keyIndex)
            marker.AnchorPoint = Vector2.new(0.5, 0.5)
            marker.Position = UDim2.new(alpha, 8 - alpha * 16, 0.5, 0)
            marker.Size = UDim2.fromOffset(9, 9)
            marker.Rotation = 45
            marker.BackgroundColor3 = COLORS.accent
            marker.BorderSizePixel = 0
            marker.Text = ""
            marker.AutoButtonColor = false
            marker.ZIndex = 4
            setToolTip(marker, string.format("%s · %.2fs", track.joint, key.time))
            local isSelectedKey = isSelectedTrack and selectedKeyIndex == keyIndex
            marker.BackgroundColor3 = isSelectedKey and COLORS.text or (isSelectedTrack and COLORS.accentSoft or COLORS.accent)
            marker.Size = isSelectedKey and UDim2.fromOffset(12, 12) or UDim2.fromOffset(9, 9)
            marker.Parent = row
            keyMarkerByKey[key] = { marker = marker, trackIndex = trackIndex, keyIndex = keyIndex }
            setToolTip(marker, string.format("%s · %.2fs%s", track.joint, key.time, keyIndex > 1 and keyIndex < #track.keys and " · drag to retime" or " · endpoint fixed"))
            marker.InputBegan:Connect(function(input)
                if input.UserInputType ~= Enum.UserInputType.MouseButton1 then return end
                local isInterior = keyIndex > 1 and keyIndex < #track.keys
                local shiftHeld = UserInputService:IsKeyDown(Enum.KeyCode.LeftShift) or UserInputService:IsKeyDown(Enum.KeyCode.RightShift)
                if shiftHeld then
                    local isSelected = KeyframeSelection.toggleSelection(selectedKeys, key)
                    if isSelected then
                        selectKey(trackIndex, keyIndex, true, true)
                    else
                        local fallbackTrackIndex, fallbackKeyIndex
                        for candidateTrackIndex, candidateTrack in editableTracks() do
                            for candidateKeyIndex, candidateKey in candidateTrack.keys do
                                if selectedKeys[candidateKey] then fallbackTrackIndex, fallbackKeyIndex = candidateTrackIndex, candidateKeyIndex; break end
                            end
                            if fallbackTrackIndex then break end
                        end
                        if fallbackTrackIndex then
                            selectKey(fallbackTrackIndex, fallbackKeyIndex, true, true)
                        else
                            selectedKeyTrackIndex, selectedKeyIndex = nil, nil
                            UI.keyEditor.Visible = false
                            refreshOnionSkin()
                        end
                    end
                    updateKeySelectionAppearance()
                else
                    selectKey(trackIndex, keyIndex, true)
                    updateKeySelectionAppearance()
                end
                if isInterior and selectedKeys[key] then
                    local originalTimes, selectedCount = {}, 0
                    for _, candidateTrack in editableTracks() do
                        for _, candidateKey in candidateTrack.keys do
                            if selectedKeys[candidateKey] then originalTimes[candidateKey] = candidateKey.time; selectedCount += 1 end
                        end
                    end
                    draggingKey = { trackIndex = trackIndex, keyIndex = keyIndex, pointerStartX = UI.pointerPosition().X,
                        anchorTime = key.time, originalTimes = originalTimes, selectedCount = selectedCount, moved = false }
                end
            end)
        end
    end
    local semanticRowIndex = #editableTracks()
    local function addSemanticRow(name, color, tooltip)
        semanticRowIndex += 1
        local y = (semanticRowIndex - 1) * rowHeight
        local label = Instance.new("TextLabel")
        label.Name = "Semantic_" .. name
        label.Position = UDim2.fromOffset(4, y)
        label.Size = UDim2.new(1, -8, 0, rowHeight)
        label.BackgroundTransparency = 1
        label.Font = FONTS.ui
        label.TextSize = 9
        label.TextColor3 = color
        label.TextXAlignment = Enum.TextXAlignment.Left
        label.TextTruncate = Enum.TextTruncate.AtEnd
        label.Text = name
        setToolTip(label, tooltip)
        label.Parent = UI.trackNames
        local row = Instance.new("Frame")
        row.Name = "SemanticRow_" .. name
        row.Position = UDim2.fromOffset(0, y)
        row.Size = UDim2.new(1, 0, 0, rowHeight)
        row.BackgroundColor3 = semanticRowIndex % 2 == 0 and COLORS.raised or COLORS.control
        row.BackgroundTransparency = 0.68
        row.BorderSizePixel = 0
        row.Parent = UI.keyMarkers
        local line = Instance.new("Frame")
        line.Name = "LaneLine"
        line.Position = UDim2.new(0, 8, 0.5, 0)
        line.Size = UDim2.new(1, -16, 0, 1)
        line.BackgroundColor3 = color
        line.BackgroundTransparency = 0.72
        line.BorderSizePixel = 0
        line.Parent = row
        return row
    end
    local rootRow = addSemanticRow("ROOT", Color3.fromRGB(71, 225, 235), "Dedicated additive root-motion keys. Drag interior keys to retime; the channel composes with the named joint pose.")
    local rootMotion = currentRecipe.rootMotion
    if rootMotion then
        for keyIndex, key in rootMotion.keys do
            local alpha = math.clamp(timelineTimeToAlpha(key.time, duration), 0, 1)
            local marker = text(rootRow, "TextButton", "", UDim2.new(alpha, 8 - alpha * 16, 0.5, 0), UDim2.fromOffset(9, 9))
            marker.Name = "RootKey_" .. tostring(keyIndex)
            marker.AnchorPoint = Vector2.new(0.5, 0.5)
            marker.Rotation = 45
            marker.BackgroundColor3 = Color3.fromRGB(71, 225, 235)
            marker.BorderSizePixel = 0
            marker.ZIndex = 4
            setToolTip(marker, string.format("Root motion · %s · %.3fs · Δ(%.2f, %.2f, %.2f) studs", rootMotion.joint, key.time, key.position[1], key.position[2], key.position[3]))
            marker.InputBegan:Connect(function(input)
                if input.UserInputType ~= Enum.UserInputType.MouseButton1 then return end
                selectedEventIndex = nil
                UI.removeEventButton.Active = false
                UI.removeEventButton.TextTransparency = 0.5
                if keyIndex > 1 and keyIndex < #rootMotion.keys then draggingSemanticKey = { kind = "rootMotion", index = keyIndex, marker = marker, moved = false } end
                updatePlayhead(key.time)
                stopEditorPlayback()
                showPose(key.time)
                UI.status.Text = string.format("Root travel · %s · %.3fs · %.2f studs", rootMotion.joint, key.time, Vector3.new(key.position[1], key.position[2], key.position[3]).Magnitude)
            end)
        end
    else
        local empty = text(rootRow, "TextLabel", "No separate root travel", UDim2.fromOffset(12, 0), UDim2.new(1, -24, 1, 0))
        empty.BackgroundTransparency = 1
        empty.TextSize = 9
        empty.TextColor3 = COLORS.muted
        empty.TextXAlignment = Enum.TextXAlignment.Left
    end
    local contactsRow = addSemanticRow("CONTACTS", Color3.fromRGB(186, 141, 255), "Declared support/grip intervals. Bands are authoring intent; contact drift in Review is measured, not physically simulated.")
    local contacts = currentRecipe.contacts or {}
    if #contacts == 0 then
        local empty = text(contactsRow, "TextLabel", "No contact intervals", UDim2.fromOffset(12, 0), UDim2.new(1, -24, 1, 0))
        empty.BackgroundTransparency = 1
        empty.TextSize = 9
        empty.TextColor3 = COLORS.muted
        empty.TextXAlignment = Enum.TextXAlignment.Left
    else
        for contactIndex, contact in contacts do
            if contact["end"] >= viewStart and contact.start <= viewEnd then
                local visibleStart, visibleEnd = math.max(contact.start, viewStart), math.min(contact["end"], viewEnd)
                local startAlpha = math.clamp(timelineTimeToAlpha(visibleStart, duration), 0, 1)
                local endAlpha = math.clamp(timelineTimeToAlpha(visibleEnd, duration), 0, 1)
                local band = text(contactsRow, "TextButton", "", UDim2.new(startAlpha, 8 - startAlpha * 16, 0, 3 + ((contactIndex - 1) % 2) * 11), UDim2.new(math.max(endAlpha - startAlpha, 0), math.max((endAlpha - startAlpha) * math.max(UI.trackArea.AbsoluteSize.X, 1) - 1, 1), 0, 9))
                band.Name = "Contact_" .. tostring(contactIndex)
                band.Text = ""
                band.BackgroundColor3 = contact.kind == "support" and Color3.fromRGB(186, 141, 255) or Color3.fromRGB(76, 205, 255)
                band.BackgroundTransparency = 0.18
                band.BorderSizePixel = 0
                band.ZIndex = 3
                setToolTip(band, string.format("%s · %s · %.3f–%.3fs · drag either edge to retime", contact.effector, contact.kind, contact.start, contact["end"]))
                band.InputBegan:Connect(function(input)
                    if input.UserInputType ~= Enum.UserInputType.MouseButton1 then return end
                    local relativeX = UI.pointerPosition().X - band.AbsolutePosition.X
                    local edgeDistance = math.min(relativeX, band.AbsoluteSize.X - relativeX)
                    if edgeDistance <= 9 then
                        draggingContactHandle = { index = contactIndex, edge = relativeX <= band.AbsoluteSize.X / 2 and "start" or "end", band = band, moved = false }
                        return
                    end
                    selectedEventIndex = nil
                    UI.removeEventButton.Active = false
                    UI.removeEventButton.TextTransparency = 0.5
                    local time = (contact.start + contact["end"]) / 2
                    updatePlayhead(time)
                    stopEditorPlayback()
                    showPose(time)
                    UI.status.Text = string.format("%s %s · %.3f–%.3fs · drag the edges to edit; Review measures sampled drift", contact.effector, contact.kind, contact.start, contact["end"])
                end)
            end
        end
    end
    local eventsRow = addSemanticRow("EVENTS", Color3.fromRGB(245, 196, 92), "Persistent animation events exported with the clip. Drag a marker to retime it; click to inspect its pose.")
    for eventIndex, event in currentRecipe.markers or {} do
        local alpha = math.clamp(timelineTimeToAlpha(event.time, duration), 0, 1)
        local marker = text(eventsRow, "TextButton", "◆", UDim2.new(alpha, 8 - alpha * 16, 0.5, 0), UDim2.fromOffset(18, 20))
        marker.Name = "AnimationEvent_" .. tostring(eventIndex)
        marker.AnchorPoint = Vector2.new(0.5, 0.5)
        marker.TextSize = 10
        marker.TextColor3 = eventIndex == selectedEventIndex and COLORS.text or Color3.fromRGB(245, 196, 92)
        marker.BackgroundTransparency = 1
        marker.ZIndex = 5
        setToolTip(marker, string.format("%s · %.3fs%s · drag to retime", event.name, event.time, event.value and (" · " .. event.value) or ""))
        marker.InputBegan:Connect(function(input)
            if input.UserInputType ~= Enum.UserInputType.MouseButton1 then return end
            selectedEventIndex = eventIndex
            selectedReviewMarker = nil
            UI.reviewMarkerNameBox.Visible = true
            UI.reviewMarkerNameBox.Text = event.name
            UI.settingsPanel.Visible = true
            UI.selectInspector(UI.settingsPanel)
            UI.removeEventButton.Active = true
            UI.removeEventButton.TextTransparency = 0
            UI.removeMarkerButton.Active = false
            UI.removeMarkerButton.TextTransparency = 0.5
            UI.selectedLabel.Text = string.format("EVENT  %s  /  %.3fs", event.name, event.time)
            updatePlayhead(event.time)
            stopEditorPlayback()
            showPose(event.time)
            draggingSemanticKey = { kind = "event", index = eventIndex, marker = marker, moved = false }
        end)
    end
    if #(currentRecipe.markers or {}) == 0 then
        local empty = text(eventsRow, "TextLabel", "No animation events", UDim2.fromOffset(12, 0), UDim2.new(1, -24, 1, 0))
        empty.BackgroundTransparency = 1
        empty.TextSize = 9
        empty.TextColor3 = COLORS.muted
        empty.TextXAlignment = Enum.TextXAlignment.Left
    end
    local canvasHeight = semanticRowIndex * rowHeight
    UI.trackArea.CanvasSize = UDim2.fromOffset(0, canvasHeight)
    UI.trackNames.CanvasSize = UDim2.fromOffset(0, canvasHeight)
    UI.keyMarkers.Size = UDim2.new(1, 0, 0, canvasHeight)
    UI.timelineHint.Text = string.format("%.1f×", duration / viewSpan)
    updatePlayhead(tonumber(UI.scrubber.Text) or 0)
    updateKeySelectionAppearance()
end
UI.reviewMarkerNameBox.FocusLost:Connect(function()
    local event = selectedEventIndex and currentRecipe and currentRecipe.markers and currentRecipe.markers[selectedEventIndex]
    if event then
        local name = string.match(UI.reviewMarkerNameBox.Text, "^%s*(.-)%s*$") or ""
        if #name < 1 or #name > 80 or string.find(name, "%c") then
            UI.reviewMarkerNameBox.Text = event.name
            UI.status.Text = "Event names must be 1–80 characters without control characters."
            return
        end
        if name == event.name then return end
        pushUndoSnapshot()
        event.name = name
        UI.setRecipeDirty(true)
        UI.selectedLabel.Text = string.format("EVENT  %s  /  %.3fs", event.name, event.time)
        refreshTimeline()
        UI.status.Text = "Renamed persistent animation event. Save Revision to preserve it."
        return
    end
    local marker = selectedReviewMarker and reviewMarkers[selectedReviewMarker]
    if not marker then return end
    local name = string.match(UI.reviewMarkerNameBox.Text, "^%s*(.-)%s*$") or ""
    if #name < 1 or #name > 40 or string.find(name, "%c") then
        UI.reviewMarkerNameBox.Text = marker.name
        UI.status.Text = "Marker names must be 1–40 characters without control characters."
        return
    end
    marker.name = name
    refreshTimeline()
    UI.status.Text = "Renamed review bookmark to “" .. name .. "”."
end)
local function addReviewMarker()
    if not currentRecipe then UI.status.Text = "Load an animation before adding a review marker."; return end
    local time = math.clamp(tonumber(UI.scrubber.Text) or 0, 0, currentRecipe.duration)
    local markerName = string.format("Pose at %.2fs", time)
    table.insert(reviewMarkers, { name = markerName, time = time })
    selectedReviewMarker = #reviewMarkers
    selectedEventIndex = nil
    UI.removeEventButton.Active = false
    UI.removeEventButton.TextTransparency = 0.5
    UI.reviewMarkerNameBox.Visible = true
    UI.reviewMarkerNameBox.Text = markerName
    UI.settingsPanel.Visible = true
    UI.selectInspector(UI.settingsPanel)
    UI.removeMarkerButton.Active = true
    UI.removeMarkerButton.TextTransparency = 0
    refreshTimeline()
    UI.status.Text = string.format("Added %s at %.2fs. Markers are session-only review notes.", markerName, time)
end
local function removeReviewMarker()
    if not selectedReviewMarker or not reviewMarkers[selectedReviewMarker] then
        UI.status.Text = "Select a timeline marker to remove it."
        return
    end
    local removed = table.remove(reviewMarkers, selectedReviewMarker)
    selectedReviewMarker = nil
    selectedEventIndex = nil
    UI.reviewMarkerNameBox.Visible = false
    UI.removeMarkerButton.Active = false
    UI.removeMarkerButton.TextTransparency = 0.5
    refreshTimeline()
    UI.status.Text = "Removed " .. removed.name .. ". Review markers are not part of the saved animation."
end
UI.addMarkerButton.MouseButton1Click:Connect(addReviewMarker)
UI.removeMarkerButton.MouseButton1Click:Connect(removeReviewMarker)
UI.addAnimationEvent = function()
    local ok, err = pcall(function()
        assert(currentRecipe, "Load an animation before adding an event.")
        currentRecipe.markers = currentRecipe.markers or {}
        assert(#currentRecipe.markers < 100, "The animation already has the maximum of 100 events.")
        pushUndoSnapshot()
        local time = math.clamp(tonumber(UI.scrubber.Text) or 0, 0, currentRecipe.duration)
        local newEvent = { name = "Event", time = time }
        table.insert(currentRecipe.markers, newEvent)
        table.sort(currentRecipe.markers, function(left, right) return left.time < right.time end)
        selectedEventIndex = table.find(currentRecipe.markers, newEvent)
        selectedReviewMarker = nil
        UI.reviewMarkerNameBox.Visible = true
        UI.reviewMarkerNameBox.Text = "Event"
        UI.settingsPanel.Visible = true
        UI.selectInspector(UI.settingsPanel)
        UI.reviewMarkerNameBox:CaptureFocus()
        UI.removeEventButton.Active = true
        UI.removeEventButton.TextTransparency = 0
        UI.removeMarkerButton.Active = false
        UI.removeMarkerButton.TextTransparency = 0.5
        UI.setRecipeDirty(true)
        UI.selectedLabel.Text = string.format("EVENT  Event  /  %.3fs", time)
        refreshTimeline()
        updatePlayhead(time)
        showPose(time)
        UI.status.Text = "Persistent animation event added. Name it above, then Save Revision to preserve it."
    end)
    if not ok then UI.status.Text = tostring(err) end
end
UI.removeAnimationEvent = function()
    local ok, err = pcall(function()
        assert(selectedEventIndex and currentRecipe and currentRecipe.markers[selectedEventIndex], "Select an event in the timeline first.")
        local removed = currentRecipe.markers[selectedEventIndex]
        pushUndoSnapshot()
        table.remove(currentRecipe.markers, selectedEventIndex)
        selectedEventIndex = nil
        UI.setRecipeDirty(true)
        UI.reviewMarkerNameBox.Visible = false
        UI.removeEventButton.Active = false
        UI.removeEventButton.TextTransparency = 0.5
        UI.removeEventButton.Active = false
        UI.removeEventButton.TextTransparency = 0.5
        refreshTimeline()
        UI.status.Text = "Removed persistent event “" .. removed.name .. "”. Save Revision to preserve the change."
    end)
    if not ok then UI.status.Text = tostring(err) end
end
UI.addEventButton.MouseButton1Click:Connect(UI.addAnimationEvent)
UI.removeEventButton.MouseButton1Click:Connect(UI.removeAnimationEvent)
local function updateKeyTimeBounds()
    local track = currentRecipe and selectedKeyTrackIndex and editableTracks()[selectedKeyTrackIndex]
    local key = track and selectedKeyIndex and track.keys[selectedKeyIndex]
    if not track or not key then
        UI.keyTimeRangeHint.Text = "Select a key to see its timing range"
        UI.applyKeyButton.Active = false
        UI.applyKeyButton.TextTransparency = 0.5
        return
    end
    local isInterior = selectedKeyIndex > 1 and selectedKeyIndex < #track.keys
    if not isInterior then
        local fixedTime = selectedKeyIndex == 1 and 0 or currentRecipe.duration
        UI.keyTimeRangeHint.Text = string.format("Endpoint is fixed at %.3f s", fixedTime)
        UI.keyTimeRangeHint.TextColor3 = COLORS.muted
        UI.applyKeyButton.Active = true
        UI.applyKeyButton.TextTransparency = 0
        setToolTip(UI.keyTimeBox, "Start and end keys are fixed at the clip endpoints")
        return
    end
    local previousTime = track.keys[selectedKeyIndex - 1].time
    local nextTime = track.keys[selectedKeyIndex + 1].time
    local requestedTime = tonumber(UI.keyTimeBox.Text)
    local isValid = requestedTime ~= nil and requestedTime == requestedTime and math.abs(requestedTime) < math.huge and requestedTime > previousTime and requestedTime < nextTime
    UI.keyTimeRangeHint.Text = string.format("Allowed: > %.3f s and < %.3f s", previousTime, nextTime)
    UI.keyTimeRangeHint.TextColor3 = isValid and COLORS.accent or Color3.fromRGB(255, 145, 158)
    UI.keyTimeBox.TextColor3 = isValid and COLORS.text or Color3.fromRGB(255, 145, 158)
    UI.applyKeyButton.Active = isValid
    UI.applyKeyButton.TextTransparency = isValid and 0 or 0.5
    setToolTip(UI.keyTimeBox, string.format("Must be greater than %.6f and less than %.6f seconds", previousTime, nextTime))
end
UI.keyTimeBox:GetPropertyChangedSignal("Text"):Connect(updateKeyTimeBounds)
local function updatePoseSpacingHint(track, keyIndex)
    local current = track and track.keys[keyIndex]
    if not current then
        UI.poseSpacingHint.Text = "NEIGHBORS  ·  Select a key"
        return
    end
    local function deltaText(neighbor, direction)
        if not neighbor then return direction .. " —" end
        local gap = math.abs(neighbor.time - current.time)
        local positionDelta = Vector3.new(
            neighbor.position[1] - current.position[1],
            neighbor.position[2] - current.position[2],
            neighbor.position[3] - current.position[3]
        ).Magnitude
        local currentRotation = CFrame.fromOrientation(math.rad(current.rotation[1]), math.rad(current.rotation[2]), math.rad(current.rotation[3]))
        local neighborRotation = CFrame.fromOrientation(math.rad(neighbor.rotation[1]), math.rad(neighbor.rotation[2]), math.rad(neighbor.rotation[3]))
        local relativeRotation = currentRotation:ToObjectSpace(neighborRotation)
        local _, angle = relativeRotation:ToAxisAngle()
        return string.format("%s %.2fs · %.2fst / %.0f°", direction, gap, positionDelta, math.deg(angle))
    end
    UI.poseSpacingHint.Text = "NEIGHBORS  " .. deltaText(track.keys[keyIndex - 1], "←") .. "   " .. deltaText(track.keys[keyIndex + 1], "→")
end
selectKey = function(trackIndex, keyIndex, skipTimelineRefresh, preserveSelection)
    if not currentRecipe then return end
    local track = editableTracks()[trackIndex]
    local key = track and track.keys[keyIndex]
    if not track or not key then return end
    selectedKeyTrackIndex, selectedKeyIndex = trackIndex, keyIndex
    if not preserveSelection then
        table.clear(selectedKeys)
        selectedKeys[key] = true
    end
    updateKeySelectionAppearance()
    if gizmoMode == "IK" then ikGoal = nil end
    refreshOnionSkin()
    updatePoseSpacingHint(track, keyIndex)
    UI.copyPoseButton.Active = true
    UI.copyPoseButton.TextTransparency = 0
    local canPastePose = poseClipboard ~= nil and poseClipboard.joint == track.joint
    UI.pastePoseButton.Active = canPastePose
    UI.pastePoseButton.TextTransparency = canPastePose and 0 or 0.5
    setToolTip(UI.pastePoseButton, canPastePose and "Paste the copied pose onto this key" or "Copy a pose from this same joint first")
    local editingLayer = selectedAnimationLayer()
    UI.keyEditorJoint.Text = editingLayer and (editingLayer.name .. " / " .. track.joint) or track.joint
    local easingStyle = key.easingStyle or "Linear"
    local easingDirection = key.easingDirection or "Out"
    UI.easingStyleButton.Text = easingStyle
    UI.easingDirectionButton.Text = easingDirection
    setToolTip(UI.easingStyleButton, "Outgoing segment: " .. easingStyle .. ". Click to cycle Linear → Constant → CubicV2 → Bounce → Elastic → Bezier.")
    setToolTip(UI.easingDirectionButton, "Outgoing segment direction: " .. easingDirection .. ". Click to cycle In → Out → InOut.")
    UI.keyTimeBox.Text = string.format("%.3f", key.time)
    local isInterior = keyIndex > 1 and keyIndex < #track.keys
    UI.keyTimeBox.TextEditable = isInterior
    UI.keyTimeBox.TextColor3 = isInterior and COLORS.text or COLORS.muted
    UI.keyTimeBox.BackgroundTransparency = isInterior and 0 or 0.45
    for axis = 1, 3 do
        positionBoxes[axis].Text = string.format("%.3f", key.position[axis])
        rotationBoxes[axis].Text = string.format("%.3f", key.rotation[axis])
    end
    UI.deleteKeyButton.Active = isInterior
    UI.deleteKeyButton.TextTransparency = isInterior and 0 or 0.5
    setToolTip(UI.deleteKeyButton, isInterior and "Remove this interior keyframe" or "Start and end keys are required by the animation format")
    updateKeyTimeBounds()
    UI.keyEditor.Visible = true
    UI.curveToggleButton.Visible = keyIndex < #track.keys
    if refreshCurveGraph then refreshCurveGraph() end
    updatePlayhead(key.time)
    stopEditorPlayback()
    showPose(key.time)
    if not skipTimelineRefresh then refreshTimeline() end
end
local gizmoPivotScreen = nil
local function gizmoBaseFrame(target)
    if target:IsA("Motor6D") then
        if not target.Part0 then return nil end
        return target.Part0.CFrame * target.C0
    elseif target:IsA("AnimationConstraint") then
        local parentPart, _, parentOffset = Rig.jointParts(target)
        if not parentPart or not parentOffset then return nil end
        return parentPart.CFrame * parentOffset
    elseif target:IsA("Bone") then
        local parent = target.Parent
        if not parent then return nil end
        local parentFrame = parent:IsA("Bone") and parent.TransformedWorldCFrame or parent.CFrame
        return parentFrame * target.CFrame
    end
    return nil
end
local function selectedGizmoNode()
    if not currentRecipe or not viewportClone or not selectedKeyTrackIndex or not selectedKeyIndex then return nil end
    local track = editableTracks()[selectedKeyTrackIndex]
    local key = track and track.keys[selectedKeyIndex]
    if not track or not key then return nil end
    for _, target in viewportClone:GetDescendants() do
        if Rig.isPartJoint(target) then
            local _, childPart = Rig.jointParts(target)
            if childPart and childPart.Name == track.joint then return track, key, target end
        elseif target:IsA("Bone") and target.Name == track.joint then
            return track, key, target
        end
    end
    return nil
end
setGizmoMode = function(mode)
    if not UI.gizmoModeButtons[mode] then return end
    local activeLayer = selectedAnimationLayer()
    if activeLayer and activeLayer.blendMode == "Additive" and mode ~= "Select" then
        UI.status.Text = "Additive layer offsets are edited in the numeric pose fields; viewport Move/Rotate/IK gizmos are reserved for absolute base/override poses."
        return
    end
    gizmoMode = mode
    for name, modeButton in UI.gizmoModeButtons do
        local active = name == mode
        local available = not activeLayer or activeLayer.blendMode ~= "Additive" or name == "Select"
        modeButton.Active = available
        modeButton.TextTransparency = available and 0 or 0.55
        modeButton.BackgroundColor3 = active and COLORS.accentSoft or COLORS.control
        modeButton.TextColor3 = active and COLORS.accent or COLORS.text
    end
    UI.gizmoToolbar.Visible = viewportClone ~= nil and currentRecipe ~= nil
    UI.ikEffectorRow.Visible = mode == "IK"
    UI.gizmoToolbar.Size = UDim2.fromOffset(284, mode == "IK" and 64 or 32)
    local hint = mode == "Move" and "MOVE  ·  Drag a colored axis to edit the selected key" or mode == "Rotate" and "ROTATE  ·  Drag a colored ring to edit the selected key" or mode == "IK" and "IK  ·  Choose a hand or foot, then drag its target" or "SELECT  ·  Click a joint to choose its nearest key"
    UI.status.Text = hint .. ". Changes apply to the viewport rig and are undoable."
end
for mode in UI.gizmoModeButtons do setToolTip(UI.gizmoModeButtons[mode], mode == "Move" and "Move the selected joint pose along its local X, Y, or Z axis (G)" or mode == "Rotate" and "Rotate the selected joint pose around its local X, Y, or Z axis (R)" or mode == "IK" and "Pose arms and legs by dragging a hand or foot target (I)" or "Select an animated joint in the viewport (Q)") end
local function nodeWorldPosition(node)
    if not node then return nil end
    if node.object:IsA("Bone") then return node.object.TransformedWorldCFrame.Position end
    if node.object:IsA("BasePart") then return node.object.Position end
    return nil
end
refreshIKEffectors = function()
    table.clear(ikEffectorInfo)
    if not viewportClone then
        for _, button in UI.ikEffectorButtons do button.Active = false; button.TextTransparency = 0.55 end
        return
    end
    local ok, _, byName = pcall(function() return Rig.nodes(viewportClone) end)
    if not ok or not byName then return end
    for _, slot in { "LeftHand", "RightHand", "LeftFoot", "RightFoot" } do
        local directNames = slot == "RightHand" and { "RightHand", "Right Arm" }
            or slot == "LeftHand" and { "LeftHand", "Left Arm" }
            or slot == "RightFoot" and { "RightFoot", "Right Leg" }
            or { "LeftFoot", "Left Leg" }
        local endpoint
        for _, name in directNames do
            if byName[name] and byName[name].target then endpoint = byName[name]; break end
        end
        if not endpoint then
            for name, node in byName do
                if node.target and IKSolver.isLimbJoint(name, slot) then endpoint = node; break end
            end
        end
        if endpoint then
            local chain, node = {}, endpoint
            while node and node.target and IKSolver.isLimbJoint(node.name, slot) and #chain < 6 do
                table.insert(chain, node)
                node = node.parent
            end
            if #chain > 0 then ikEffectorInfo[slot] = { endpoint = endpoint, chain = chain } end
        end
    end
    for slot, button in UI.ikEffectorButtons do
        local available = ikEffectorInfo[slot] ~= nil
        button.Active = available
        button.TextTransparency = available and 0 or 0.55
        button.BackgroundColor3 = slot == activeIKEffector and COLORS.accentSoft or COLORS.control
        local info = ikEffectorInfo[slot]
        setToolTip(button, available and ("Pose " .. info.endpoint.name .. " with inverse kinematics") or ("No matching " .. slot .. " joint exists on this rig"))
    end
    if not ikEffectorInfo[activeIKEffector] then
        for _, slot in { "RightHand", "LeftHand", "RightFoot", "LeftFoot" } do
            if ikEffectorInfo[slot] then activeIKEffector = slot; break end
        end
        ikGoal = nil
    end
end
setIKEffector = function(slot)
    local info = ikEffectorInfo[slot]
    if not info then UI.status.Text = "This rig does not contain a matching hand or foot joint."; return end
    activeIKEffector = slot
    ikGoal = nodeWorldPosition(info.endpoint)
    for name, button in UI.ikEffectorButtons do button.BackgroundColor3 = name == slot and COLORS.accentSoft or COLORS.control end
    UI.status.Text = "IK target set to " .. info.endpoint.name .. ". Drag its cyan target in the viewport; the selected key is edited."
end
local function getOrCreateIKKey(jointName, time)
    local track
    for _, candidate in editableTracks() do if candidate.joint == jointName then track = candidate; break end end
    if not track then
        assert(#editableTracks() < 256, "IK cannot add a joint because the active layer already has 256 tracks.")
        local totalKeys = 0
        for _, candidate in allRecipeTracks() do totalKeys += #candidate.keys end
        assert(totalKeys <= 4093, "IK would exceed the 4096-key animation limit.")
        track = { joint = jointName, keys = {
            { time = 0, position = { 0, 0, 0 }, rotation = { 0, 0, 0 } },
            { time = currentRecipe.duration, position = { 0, 0, 0 }, rotation = { 0, 0, 0 } },
        } }
        table.insert(editableTracks(), track)
    end
    for index, key in track.keys do if math.abs(key.time - time) <= 0.0001 then return track, key, index end end
    assert(#track.keys < 128, jointName .. " already has the maximum of 128 keys.")
    local totalKeys = 0
    for _, candidate in allRecipeTracks() do totalKeys += #candidate.keys end
    assert(totalKeys < 4096, "IK would exceed the 4096-key animation limit.")
    local pose = Authoring.sample(track, time)
    local x, y, z = pose:ToEulerAnglesXYZ()
    local key = { time = time, position = { pose.Position.X, pose.Position.Y, pose.Position.Z }, rotation = { math.deg(x), math.deg(y), math.deg(z) } }
    local insertIndex = #track.keys + 1
    for index, candidate in track.keys do if candidate.time > time then insertIndex = index; break end end
    table.insert(track.keys, insertIndex, key)
    return track, key, insertIndex
end
IKSolver.poleErrorAtPose = function(info, keysByJoint, poleTarget)
    if not poleTarget then return nil, nil end
    if #info.chain < 3 then return nil, "rig_has_fewer_than_two_limb_segments" end
    local rootNode, middleNode = info.chain[#info.chain], info.chain[2]
    local rootRecord = keysByJoint[rootNode.name]
    local rootFrame = rootNode.target and gizmoBaseFrame(rootNode.target)
    local middleFrame = middleNode.target and gizmoBaseFrame(middleNode.target)
    local endpointPosition = nodeWorldPosition(info.endpoint)
    if not rootRecord or not rootFrame or not middleFrame or not endpointPosition then return nil, "limb_joint_positions_unavailable" end
    local rootPivot = rootFrame * Authoring.transform(rootRecord.key)
    local poleX, poleY, poleZ, angle = IKSolver.poleStep(
        rootPivot.Position.X, rootPivot.Position.Y, rootPivot.Position.Z,
        middleFrame.Position.X, middleFrame.Position.Y, middleFrame.Position.Z,
        endpointPosition.X, endpointPosition.Y, endpointPosition.Z,
        poleTarget.X, poleTarget.Y, poleTarget.Z)
    if not poleX then return nil, "bend_or_pole_direction_is_degenerate" end
    return math.deg(math.abs(angle)), nil
end
local function applyIKGoal(slot, time, goal, toleranceStuds, iterationLimit, poleTarget)
    local info = ikEffectorInfo[slot]
    assert(info and #info.chain > 0, "Choose an available hand or foot IK target.")
    local keysByJoint = {}
    for _, node in info.chain do
        local track, key = getOrCreateIKKey(node.name, time)
        keysByJoint[node.name] = { track = track, key = key }
    end
    showPose(time)
    local function rotateJoint(node, key, axisX, axisY, axisZ, angle)
        local frame = node.target and gizmoBaseFrame(node.target)
        if not frame or math.abs(angle) <= math.rad(0.05) then return end
        local pivot = frame * Authoring.transform(key)
        local worldAxis = Vector3.new(axisX, axisY, axisZ)
        local nextWorld = CFrame.new(pivot.Position) * CFrame.fromAxisAngle(worldAxis, angle) * pivot.Rotation
        local localPose = frame:ToObjectSpace(nextWorld)
        local x, y, z = localPose:ToEulerAnglesXYZ()
        key.rotation = { math.deg(x), math.deg(y), math.deg(z) }
        showPose(time)
    end
    local residual = math.huge
    for _ = 1, iterationLimit or 12 do
        if poleTarget and #info.chain >= 3 then
            local rootNode, middleNode = info.chain[#info.chain], info.chain[2]
            local rootRecord = keysByJoint[rootNode.name]
            local rootFrame = rootNode.target and gizmoBaseFrame(rootNode.target)
            local middleFrame = middleNode.target and gizmoBaseFrame(middleNode.target)
            local middlePosition, endpointPosition = middleFrame and middleFrame.Position or nodeWorldPosition(middleNode), nodeWorldPosition(info.endpoint)
            if rootRecord and rootFrame and middlePosition and endpointPosition then
                local rootPivot = rootFrame * Authoring.transform(rootRecord.key)
                local axisX, axisY, axisZ, angle = IKSolver.poleStep(
                    rootPivot.Position.X, rootPivot.Position.Y, rootPivot.Position.Z,
                    middlePosition.X, middlePosition.Y, middlePosition.Z,
                    endpointPosition.X, endpointPosition.Y, endpointPosition.Z,
                    poleTarget.X, poleTarget.Y, poleTarget.Z)
                if axisX then rotateJoint(rootNode, rootRecord.key, axisX, axisY, axisZ, angle) end
            end
        end
        for _, node in info.chain do
            local target = node.target
            local frame = target and gizmoBaseFrame(target)
            local endpoint = nodeWorldPosition(info.endpoint)
            if frame and endpoint then
                local pivot = frame * Authoring.transform(keysByJoint[node.name].key)
                local axisX, axisY, axisZ, angle = IKSolver.step(pivot.Position.X, pivot.Position.Y, pivot.Position.Z, endpoint.X, endpoint.Y, endpoint.Z, goal.X, goal.Y, goal.Z)
                if axisX then rotateJoint(node, keysByJoint[node.name].key, axisX, axisY, axisZ, angle) end
            end
        end
        local endpoint = nodeWorldPosition(info.endpoint)
        if not endpoint then break end
        residual = (endpoint - goal).Magnitude
        if residual < (toleranceStuds or 0.025) then break end
    end
    if currentRecipe.loop and (time == 0 or time == currentRecipe.duration) then
        for _, record in keysByJoint do
            local track, key = record.track, record.key
            local other = time == 0 and track.keys[#track.keys] or track.keys[1]
            other.position, other.rotation = table.clone(key.position), table.clone(key.rotation)
        end
    end
    UI.setRecipeDirty(true)
    local poleErrorDegrees, poleUnavailableReason = IKSolver.poleErrorAtPose(info, keysByJoint, poleTarget)
    return residual, keysByJoint, poleErrorDegrees, poleUnavailableReason
end
local function endpointWorldFrame(node)
    if not node then return nil end
    if node.object:IsA("Bone") then return node.object.TransformedWorldCFrame end
    if node.object:IsA("BasePart") then return node.object.CFrame end
    return nil
end
local function orientationFrameFromDegrees(orientationDegrees)
    assert(type(orientationDegrees) == "table" and #orientationDegrees == 3, "IK target orientation must contain three XYZ Euler angles.")
    for _, angle in orientationDegrees do
        assert(type(angle) == "number" and angle == angle and math.abs(angle) < math.huge and math.abs(angle) <= 360,
            "IK target orientation angles must be finite and between -360 and 360 degrees.")
    end
    return CFrame.Angles(math.rad(orientationDegrees[1]), math.rad(orientationDegrees[2]), math.rad(orientationDegrees[3]))
end
local function orientationResidualDegrees(node, targetRotation)
    local actual = endpointWorldFrame(node)
    if not actual then return nil end
    local _, angle = targetRotation:ToObjectSpace(actual.Rotation):ToAxisAngle()
    return math.deg(math.abs(angle))
end
local function applyIKEndpointOrientation(info, keysByJoint, time, targetRotation)
    local node = info.endpoint
    local target = node.target
    local record = keysByJoint[node.name]
    local baseFrame = target and gizmoBaseFrame(target)
    local currentFrame = endpointWorldFrame(node)
    assert(record and baseFrame and currentFrame, "The IK endpoint driver does not expose a world frame for orientation targeting.")
    local desiredWorldFrame = CFrame.new(currentFrame.Position) * targetRotation
    local localPose
    if target:IsA("Motor6D") then
        assert(target.Part1 == node.object, "The IK endpoint Motor6D child changed during orientation targeting.")
        localPose = baseFrame:ToObjectSpace(desiredWorldFrame * target.C1)
    elseif target:IsA("AnimationConstraint") then
        local _, childPart, _, childOffset = Rig.jointParts(target)
        assert(childPart == node.object and childOffset, "The IK endpoint AnimationConstraint child changed during orientation targeting.")
        localPose = baseFrame:ToObjectSpace(desiredWorldFrame * childOffset)
    elseif target:IsA("Bone") then
        assert(target == node.object, "The IK endpoint Bone changed during orientation targeting.")
        localPose = baseFrame:ToObjectSpace(desiredWorldFrame)
    else
        error("The IK endpoint uses an unsupported orientation driver.")
    end
    local x, y, z = localPose:ToEulerAnglesXYZ()
    record.key.position = { localPose.Position.X, localPose.Position.Y, localPose.Position.Z }
    record.key.rotation = { math.deg(x), math.deg(y), math.deg(z) }
    showPose(time)
    local actualAfter = endpointWorldFrame(node)
    assert(actualAfter, "The IK endpoint world frame disappeared after orientation targeting.")
    assert((actualAfter.Position - currentFrame.Position).Magnitude <= 0.001,
        "IK orientation targeting moved the endpoint position; refusing to report a successful orientation solve.")
    return orientationResidualDegrees(node, targetRotation)
end
local function updateJointManipulator()
    if gizmoMode == "IK" then
        local info = ikEffectorInfo[activeIKEffector]
        local selectedTrack = currentRecipe and selectedKeyTrackIndex and editableTracks()[selectedKeyTrackIndex]
        local selectedKey = selectedTrack and selectedKeyIndex and selectedTrack.keys[selectedKeyIndex]
        local targetPosition = info and nodeWorldPosition(info.endpoint)
        if not info or not selectedKey or not targetPosition or not UI.viewport.Visible or not widget.Enabled then
            UI.jointManipulator.Visible = false
            gizmoPivotScreen = nil
            UI.ikTargetHalo.Visible = false
            UI.gizmoToolbar.Visible = currentRecipe ~= nil and viewportClone ~= nil
            return
        end
        ikGoal = ikGoal or targetPosition
        local projectedGoal = camera:WorldToViewportPoint(ikGoal)
        local viewportSize = UI.viewport.AbsoluteSize
        if projectedGoal.Z <= 0 or projectedGoal.X < -40 or projectedGoal.Y < -40 or projectedGoal.X > viewportSize.X + 40 or projectedGoal.Y > viewportSize.Y + 40 then
            UI.jointManipulator.Visible = false
            gizmoPivotScreen = nil
            return
        end
        gizmoPivotScreen = Vector2.new(projectedGoal.X, projectedGoal.Y)
        UI.jointManipulator.Position = UDim2.fromOffset(projectedGoal.X - 90, projectedGoal.Y - 90)
        UI.jointManipulator.Visible = true
        UI.ikTargetHalo.Visible = true
        UI.gizmoPivot.BackgroundColor3 = COLORS.accent
        UI.gizmoPivot.Size = UDim2.fromOffset(10, 10)
        for axis = 1, 3 do
            UI.gizmoAxisLines[axis].Visible = false
            UI.gizmoAxisLabels[axis].Visible = false
            UI.gizmoRotationRings[axis].Visible = false
        end
        setToolTip(UI.ikTargetHalo, "IK target · drag in the camera plane to pose " .. info.endpoint.name)
        return
    end
    UI.ikTargetHalo.Visible = false
    UI.gizmoPivot.BackgroundColor3 = COLORS.text
    UI.gizmoPivot.Size = UDim2.fromOffset(8, 8)
    local track, key, target = selectedGizmoNode()
    local baseFrame = target and gizmoBaseFrame(target)
    if not track or not key or not baseFrame or not UI.viewport.Visible or not widget.Enabled then
        UI.jointManipulator.Visible = false
        gizmoPivotScreen = nil
        table.clear(gizmoScreenAxes)
        UI.gizmoToolbar.Visible = false
        return
    end
    UI.gizmoToolbar.Visible = true
    if gizmoDrag then
        UI.jointManipulator.Visible = true
        return
    end
    if gizmoMode == "Select" then
        UI.jointManipulator.Visible = false
        gizmoPivotScreen = nil
        table.clear(gizmoScreenAxes)
        return
    end
    local pivotFrame = baseFrame * Authoring.transform(key)
    local projected = camera:WorldToViewportPoint(pivotFrame.Position)
    local viewportSize = UI.viewport.AbsoluteSize
    if projected.Z <= 0 or projected.X < -64 or projected.Y < -64 or projected.X > viewportSize.X + 64 or projected.Y > viewportSize.Y + 64 then
        UI.jointManipulator.Visible = false
        gizmoPivotScreen = nil
        table.clear(gizmoScreenAxes)
        return
    end
    local pivot = Vector2.new(projected.X, projected.Y)
    gizmoPivotScreen = pivot
    UI.jointManipulator.Position = UDim2.fromOffset(pivot.X - 90, pivot.Y - 90)
    UI.jointManipulator.Visible = true
    table.clear(gizmoScreenAxes)
    for axis = 1, 3 do
        local line, label, ring = UI.gizmoAxisLines[axis], UI.gizmoAxisLabels[axis], UI.gizmoRotationRings[axis]
        if gizmoMode == "Move" then
            local worldAxis = baseFrame:VectorToWorldSpace(({ Vector3.xAxis, Vector3.yAxis, Vector3.zAxis })[axis])
            local worldLength = math.max(1, projected.Z * 0.07)
            local endPoint, onScreen = camera:WorldToViewportPoint(pivotFrame.Position + worldAxis * worldLength)
            local screenVector = Vector2.new(endPoint.X, endPoint.Y) - pivot
            local projectedAxis = Manipulator.projectAxis(screenVector.X, screenVector.Y, worldLength)
            if onScreen and projectedAxis and projectedAxis.studsPerPixel > 0.01 then
                local direction = Vector2.new(projectedAxis.x, projectedAxis.y)
                local angle = math.deg(math.atan2(direction.Y, direction.X))
                line.Position = UDim2.fromOffset(90 + direction.X * 8, 90 + direction.Y * 8)
                line.Rotation = angle
                line.Size = UDim2.fromOffset(58, 3)
                label.Position = UDim2.fromOffset(90 + direction.X * 69, 90 + direction.Y * 69)
                gizmoScreenAxes[axis] = { direction = direction, studsPerPixel = projectedAxis.studsPerPixel }
            end
            line.Visible = gizmoScreenAxes[axis] ~= nil
            label.Visible = gizmoScreenAxes[axis] ~= nil
            ring.Visible = false
        else
            line.Visible = false
            label.Visible = false
            ring.Visible = true
        end
    end
end
local function selectViewportJoint(inputPosition)
    if not currentRecipe or not viewportClone then return end
    local viewportSize = UI.viewport.AbsoluteSize
    if viewportSize.X <= 0 or viewportSize.Y <= 0 then return end
    local localPosition = inputPosition - UI.viewport.AbsolutePosition
    local pointer = Vector2.new(localPosition.X, localPosition.Y)
    local playheadTime = tonumber(UI.scrubber.Text) or 0
    local bestTrackIndex, bestKeyIndex, bestDistance, bestDepth
    for trackIndex, track in editableTracks() do
        local target = viewportClone:FindFirstChild(track.joint, true)
        local targetPosition
        if target and target:IsA("BasePart") then
            targetPosition = target.Position
        elseif target and target:IsA("Bone") then
            targetPosition = target.TransformedWorldCFrame.Position
        end
        if targetPosition then
            local projected, onScreen = camera:WorldToViewportPoint(targetPosition)
            if onScreen and projected.Z > 0 then
                local pixelDelta = Vector2.new(projected.X - pointer.X, projected.Y - pointer.Y)
                local pixelDistance = pixelDelta.Magnitude
                if pixelDistance <= 32 and (not bestDistance or pixelDistance < bestDistance or (pixelDistance == bestDistance and projected.Z < bestDepth)) then
                    local nearestKeyIndex, nearestTimeDelta = 1, math.huge
                    for keyIndex, key in track.keys do
                        local timeDelta = math.abs(key.time - playheadTime)
                        if timeDelta < nearestTimeDelta then nearestKeyIndex, nearestTimeDelta = keyIndex, timeDelta end
                    end
                    bestTrackIndex, bestKeyIndex = trackIndex, nearestKeyIndex
                    bestDistance, bestDepth = pixelDistance, projected.Z
                end
            end
        end
    end
    if bestTrackIndex and bestKeyIndex then
        local track = editableTracks()[bestTrackIndex]
        local key = track.keys[bestKeyIndex]
        selectKey(bestTrackIndex, bestKeyIndex)
        UI.status.Text = string.format("Selected %s · nearest key at %.2fs. Edit the pose in the viewport panel.", track.joint, key.time)
    end
end
local function beginJointDrag(inputPosition)
    if gizmoMode == "Select" or not gizmoPivotScreen then return false end
    local localPosition = inputPosition - UI.viewport.AbsolutePosition
    local pointer = Vector2.new(localPosition.X, localPosition.Y)
    local track, key = selectedGizmoNode()
    if not track or not key then return false end
    local hitAxis, hitDistance
    if gizmoMode == "IK" then
        local targetOffset = pointer - gizmoPivotScreen
        if targetOffset.Magnitude <= 24 and ikEffectorInfo[activeIKEffector] then hitAxis, hitDistance = 1, targetOffset.Magnitude end
    elseif gizmoMode == "Move" then
        for axis, projectedAxis in gizmoScreenAxes do
            local offset = pointer - gizmoPivotScreen
            local hit, perpendicular = Manipulator.moveHandleHit(offset.X, offset.Y, projectedAxis.direction.X, projectedAxis.direction.Y, 5, 76, 11)
            if hit and (not hitDistance or perpendicular < hitDistance) then
                hitAxis, hitDistance = axis, perpendicular
            end
        end
    elseif gizmoMode == "Rotate" then
        local offset = pointer - gizmoPivotScreen
        local nearestError = math.huge
        for axis = 1, 3 do
            local ringRadius = 24 + (axis - 1) * 9
            local hit = Manipulator.ringHandleHit(offset.X, offset.Y, ringRadius, 8)
            local error = math.abs(offset.Magnitude - ringRadius)
            if hit and error < nearestError then hitAxis, nearestError = axis, error end
        end
    end
    if not hitAxis then return false end
    stopEditorPlayback()
    local position, rotation = table.clone(key.position), table.clone(key.rotation)
    gizmoDrag = {
        trackIndex = selectedKeyTrackIndex,
        keyIndex = selectedKeyIndex,
        axis = hitAxis,
        mode = gizmoMode,
        startPointer = pointer,
        pivot = gizmoPivotScreen,
        axisProjection = gizmoScreenAxes[hitAxis],
        originalPosition = position,
        originalRotation = rotation,
        originalRecipe = gizmoMode == "IK" and cloneRecipe(currentRecipe) or nil,
        startGoal = gizmoMode == "IK" and ikGoal or nil,
        lastGoal = gizmoMode == "IK" and ikGoal or nil,
        solveTime = key.time,
        selectedJoint = track.joint,
        effectorSlot = activeIKEffector,
        changed = false,
        undoPushed = false,
    }
    return true
end
UI.viewportSelectConnection = UI.viewport.InputBegan:Connect(function(input)
    if input.UserInputType == Enum.UserInputType.MouseButton1 and gizmoMode == "Select"
        and UI.viewportPointAvailable(UI.pointerPosition()) then
        selectViewportJoint(UI.pointerPosition())
    end
end)
UI.gizmoInputStartConnection = UserInputService.InputBegan:Connect(function(input, gameProcessed)
    if input.UserInputType ~= Enum.UserInputType.MouseButton1 or not widget.Enabled or not UI.viewport.Visible then return end
    if gizmoMode == "Select" or gameProcessed then return end
    if UserInputService:GetFocusedTextBox() then return end
    local point = UI.pointerPosition()
    if not UI.viewportPointAvailable(point) then return end
    local viewportPosition, viewportSize = UI.viewport.AbsolutePosition, UI.viewport.AbsoluteSize
    if point.X < viewportPosition.X or point.Y < viewportPosition.Y or point.X > viewportPosition.X + viewportSize.X or point.Y > viewportPosition.Y + viewportSize.Y then return end
    local toolbarPosition, toolbarSize = UI.gizmoToolbar.AbsolutePosition, UI.gizmoToolbar.AbsoluteSize
    if UI.gizmoToolbar.Visible and point.X >= toolbarPosition.X and point.X <= toolbarPosition.X + toolbarSize.X and point.Y >= toolbarPosition.Y and point.Y <= toolbarPosition.Y + toolbarSize.Y then return end
    if not beginJointDrag(point) then selectViewportJoint(point) end
end)
cloneRecipe = function(recipe)
    return HttpService:JSONDecode(HttpService:JSONEncode(recipe))
end
local function updateHistoryButtons()
    UI.undoButton.Active = #undoStack > 0
    UI.redoButton.Active = #redoStack > 0
    UI.undoButton.TextTransparency = #undoStack > 0 and 0 or 0.5
    UI.redoButton.TextTransparency = #redoStack > 0 and 0 or 0.5
end
local function captureSelectedKeyIndices()
    return KeyframeSelection.captureSelectionIndices(editableTracks(), selectedKeys)
end
local function restoreSelectedKeyIndices(indices)
    selectedKeys = KeyframeSelection.restoreSelection(editableTracks(), indices)
    updateKeySelectionAppearance()
end
pushUndoSnapshot = function()
    assert(currentRecipe, "Load an animation before editing.")
    table.insert(undoStack, {
        recipe = cloneRecipe(currentRecipe),
        layerId = activeLayerId,
        trackIndex = selectedKeyTrackIndex,
        keyIndex = selectedKeyIndex,
        selectedKeyIndices = captureSelectedKeyIndices(),
        reviewMarkers = cloneRecipe(reviewMarkers),
        selectedReviewMarker = selectedReviewMarker,
        selectedEventIndex = selectedEventIndex,
        playbackRangeIn = playbackRangeIn,
        playbackRangeOut = playbackRangeOut,
        previewLoop = previewLoop,
        timelineViewStart = timelineViewStart,
        timelineViewSpan = timelineViewSpan,
    })
    if #undoStack > maximumUndoSteps then table.remove(undoStack, 1) end
    table.clear(redoStack)
    updateHistoryButtons()
end
local defaultBezierCurve = { outTime = 0.25, outValue = 0.1, inTime = 0.75, inValue = 0.9 }
local function bezierCurveForSelectedKey()
    if not currentRecipe or not selectedKeyTrackIndex or not selectedKeyIndex then return nil end
    local key = editableTracks()[selectedKeyTrackIndex].keys[selectedKeyIndex]
    if not key or selectedKeyIndex >= #editableTracks()[selectedKeyTrackIndex].keys then return nil end
    local curve = key.curve or defaultBezierCurve
    return key, curve
end
refreshCurveGraph = function()
    if not UI.curveGraph then return end
    for _, child in UI.curveGraph:GetChildren() do child:Destroy() end
    local key, curve = bezierCurveForSelectedKey()
    if not key then
        UI.curveTitle.Text = "SELECT A NON-ENDPOINT KEY"
        UI.curveGraph.Visible = false
        UI.curvePanel.Visible = false
        return
    end
    UI.curveGraph.Visible = true
    local track = editableTracks()[selectedKeyTrackIndex]
    local nextKey = track.keys[selectedKeyIndex + 1]
    local isBezier = key.easingStyle == "Bezier"
    UI.curveTitle.Text = string.format("%s  ·  %s  ·  %.3f → %.3fs", track.joint, key.easingStyle or "Linear", key.time, nextKey.time)
    local width, height = UI.curveGraph.AbsoluteSize.X, UI.curveGraph.AbsoluteSize.Y
    local function point(x, y)
        return Vector2.new(8 + math.clamp(x, 0, 1) * math.max(width - 16, 1), 8 + (2 - y) / 3 * math.max(height - 16, 1))
    end
    local function segment(name, from, to, color, thickness)
        local delta = to - from
        local line = Instance.new("Frame")
        line.Name = name
        line.AnchorPoint = Vector2.new(0, 0.5)
        line.Position = UDim2.fromOffset(from.X, from.Y)
        line.Size = UDim2.fromOffset(math.max(delta.Magnitude, 1), thickness)
        line.Rotation = math.deg(math.atan2(delta.Y, delta.X))
        line.BackgroundColor3 = color
        line.BorderSizePixel = 0
        line.ZIndex = 12
        line.Parent = UI.curveGraph
    end
    for index = 0, 4 do
        local x = 8 + (width - 16) * index / 4
        local y = 8 + (height - 16) * index / 4
        local vertical = Instance.new("Frame")
        vertical.Name = "GridX" .. index
        vertical.Position = UDim2.fromOffset(x, 0)
        vertical.Size = UDim2.new(0, 1, 1, 0)
        vertical.BackgroundColor3 = COLORS.border
        vertical.BackgroundTransparency = 0.68
        vertical.BorderSizePixel = 0
        vertical.ZIndex = 11
        vertical.Parent = UI.curveGraph
        local horizontal = vertical:Clone()
        horizontal.Name = "GridY" .. index
        horizontal.Position = UDim2.fromOffset(0, y)
        horizontal.Size = UDim2.new(1, 0, 0, 1)
        horizontal.Parent = UI.curveGraph
    end
    local p0, p1 = point(0, 0), point(curve.outTime, curve.outValue)
    local p2, p3 = point(curve.inTime, curve.inValue), point(1, 1)
    if isBezier then
        segment("OutgoingHandle", p0, p1, COLORS.muted, 1)
        segment("IncomingHandle", p3, p2, COLORS.muted, 1)
    end
    local function sampleCurve(t)
        if not isBezier then
            local alpha = Authoring.easeAlpha(key.easingStyle or "Linear", key.easingDirection or "Out", t, key.curve)
            return point(t, alpha)
        end
        local u = 1 - t
        local x = 3 * u ^ 2 * t * curve.outTime + 3 * u * t ^ 2 * curve.inTime + t ^ 3
        local y = 3 * u ^ 2 * t * curve.outValue + 3 * u * t ^ 2 * curve.inValue + t ^ 3
        return point(x, y)
    end
    local previous = sampleCurve(0)
    for index = 1, 32 do
        local current = sampleCurve(index / 32)
        segment("Curve" .. index, previous, current, COLORS.accent, 2)
        previous = current
    end
    local function handle(name, controlName, position, color)
        local button = text(UI.curveGraph, "TextButton", "", UDim2.fromOffset(position.X - 6, position.Y - 6), UDim2.fromOffset(12, 12))
        button.Name = name
        button.BackgroundColor3 = color
        button.ZIndex = 14
        local corner = Instance.new("UICorner")
        corner.CornerRadius = UDim.new(1, 0)
        corner.Parent = button
        local stroke = Instance.new("UIStroke")
        stroke.Color = COLORS.text
        stroke.Thickness = 1
        stroke.Parent = button
        setToolTip(button, controlName == "out" and "Drag outgoing Bézier handle" or "Drag incoming Bézier handle")
        button.InputBegan:Connect(function(input)
            if input.UserInputType ~= Enum.UserInputType.MouseButton1 then return end
            pushUndoSnapshot()
            curveDrag = { control = controlName, moved = false }
            stopEditorPlayback()
        end)
    end
    if isBezier then
        handle("OutHandle", "out", p1, Color3.fromRGB(113, 198, 255))
        handle("InHandle", "in", p2, Color3.fromRGB(190, 137, 255))
        UI.curveHint.Text = "Drag handles · normalized time / pose progress · undoable"
    else
        UI.curveHint.Text = "Preview only · choose Bezier in the key inspector to edit custom handles"
    end
end
UI.curveToggleButton.Activated:Connect(function()
    UI.curvePanel.Visible = not UI.curvePanel.Visible
    refreshCurveGraph()
end)
UI.curveCloseButton.Activated:Connect(function() UI.curvePanel.Visible = false end)
UI.curveInputChangedConnection = UserInputService.InputChanged:Connect(function(input)
    if not curveDrag or input.UserInputType ~= Enum.UserInputType.MouseMovement then return end
    local key, curve = bezierCurveForSelectedKey()
    if not key then curveDrag = nil; return end
    local point = UI.pointerPosition()
    local origin, size = UI.curveGraph.AbsolutePosition, UI.curveGraph.AbsoluteSize
    local x = math.clamp((point.X - origin.X - 8) / math.max(size.X - 16, 1), 0, 1)
    local y = math.clamp(2 - ((point.Y - origin.Y - 8) / math.max(size.Y - 16, 1)) * 3, -1, 2)
    local nextCurve = { outTime = curve.outTime, outValue = curve.outValue, inTime = curve.inTime, inValue = curve.inValue }
    if curveDrag.control == "out" then
        nextCurve.outTime = math.min(x, nextCurve.inTime)
        nextCurve.outValue = y
    else
        nextCurve.inTime = math.max(x, nextCurve.outTime)
        nextCurve.inValue = y
    end
    key.curve = nextCurve
    key.easingStyle = "Bezier"
    key.easingDirection = nil
    curveDrag.moved = true
    UI.setRecipeDirty(true)
    refreshCurveGraph()
    refreshTimeline()
    showPose(tonumber(UI.scrubber.Text) or key.time)
end)
UI.curveInputEndedConnection = UserInputService.InputEnded:Connect(function(input)
    if input.UserInputType == Enum.UserInputType.MouseButton1 then
        if curveDrag and curveDrag.moved then UI.status.Text = "Bezier handles updated · undoable · save a revision to preserve this curve." end
        curveDrag = nil
    end
end)
local easingStyles = { "Linear", "Constant", "CubicV2", "Bounce", "Elastic", "Bezier" }
local easingDirections = { "In", "Out", "InOut" }
local function cycleSelectedEasing(field, values)
    if not currentRecipe or not selectedKeyTrackIndex or not selectedKeyIndex then
        UI.status.Text = "Select a keyframe to edit its outgoing interpolation."
        return
    end
    local key = editableTracks()[selectedKeyTrackIndex].keys[selectedKeyIndex]
    local current = key[field] or (field == "easingStyle" and "Linear" or "Out")
    local currentIndex = table.find(values, current) or 0
    pushUndoSnapshot()
    key[field] = values[currentIndex % #values + 1]
    UI.setRecipeDirty(true)
    selectKey(selectedKeyTrackIndex, selectedKeyIndex)
    UI.status.Text = "Outgoing segment set to " .. key.easingStyle .. " / " .. key.easingDirection .. "."
end
UI.easingStyleButton.Activated:Connect(function()
    cycleSelectedEasing("easingStyle", easingStyles)
    local key = currentRecipe and selectedKeyTrackIndex and selectedKeyIndex and editableTracks()[selectedKeyTrackIndex].keys[selectedKeyIndex]
    if key and key.easingStyle == "Bezier" then UI.curvePanel.Visible = true; refreshCurveGraph() end
end)
UI.easingDirectionButton.Activated:Connect(function()
    cycleSelectedEasing("easingDirection", easingDirections)
end)
local function scaleClip(factor)
    if not currentRecipe then UI.status.Text = "Load an animation before retiming it."; return end
    local scaledDuration = currentRecipe.duration * factor
    if scaledDuration < 0.1 or scaledDuration > 30 then
        UI.status.Text = "Retiming would put clip duration outside the supported 0.1–30 second range."
        return
    end
    local currentTime = tonumber(UI.scrubber.Text) or 0
    stopEditorPlayback()
    pushUndoSnapshot()
    currentRecipe.duration = scaledDuration
    for _, track in allRecipeTracks() do
        for _, key in track.keys do key.time *= factor end
    end
    for _, marker in currentRecipe.markers or {} do marker.time *= factor end
    for _, marker in reviewMarkers do marker.time *= factor end
    if playbackRangeIn then playbackRangeIn *= factor end
    if playbackRangeOut then playbackRangeOut *= factor end
    updatePlaybackControls()
    UI.setRecipeDirty(true)
    local scaledTime = math.clamp(currentTime * factor, 0, scaledDuration)
    updatePlayhead(scaledTime)
    UI.durationLabel.Text = string.format("/ %.2fs", scaledDuration)
    refreshTimeline()
    if selectedKeyTrackIndex and selectedKeyIndex then
        selectKey(selectedKeyTrackIndex, selectedKeyIndex)
    else
        showPose(scaledTime)
    end
    updateHistoryButtons()
    UI.status.Text = string.format("Clip retimed to %.2fs; poses are unchanged. Undo is available; save a revision to preserve it.", scaledDuration)
end
UI.compressClipButton.MouseButton1Click:Connect(function() scaleClip(0.8) end)
UI.stretchClipButton.MouseButton1Click:Connect(function() scaleClip(1.25) end)
UI.copyPoseButton.MouseButton1Click:Connect(function()
    local track = currentRecipe and selectedKeyTrackIndex and editableTracks()[selectedKeyTrackIndex]
    local key = track and selectedKeyIndex and track.keys[selectedKeyIndex]
    if not track or not key then UI.status.Text = "Select a keyframe pose before copying."; return end
    poseClipboard = {
        joint = track.joint,
        position = { key.position[1], key.position[2], key.position[3] },
        rotation = { key.rotation[1], key.rotation[2], key.rotation[3] },
    }
    UI.pastePoseButton.Active = true
    UI.pastePoseButton.TextTransparency = 0
    setToolTip(UI.pastePoseButton, "Paste the copied pose onto another key of " .. track.joint)
    UI.status.Text = "Copied " .. track.joint .. " pose. Select another key on the same joint to paste it."
end)
local selectedLibraryPose
local function rigCompatibilityType()
    local humanoid = previewRigModel and previewRigModel:FindFirstChildOfClass("Humanoid")
    if not humanoid then return "custom" end
    return humanoid.RigType == Enum.HumanoidRigType.R15 and "R15" or "R6"
end
local function rigTopologySignature(model)
    assert(model and model:IsA("Model"), "Load a rig before capturing or applying a full-body snapshot.")
    return Rig.signature(model)
end
local function refreshPoseLibrary()
    if not connected then UI.status.Text = "Connect to the local Motion Tools server to browse saved poses."; return end
    local ok, response = pcall(function()
        return request("/poses/list", { query = UI.poseSearchBox.Text, rigType = rigCompatibilityType(), offset = 0, limit = 50 })
    end)
    if not ok then UI.status.Text = "Pose library unavailable: " .. tostring(response); return end
    for _, child in UI.poseList:GetChildren() do child:Destroy() end
    selectedLibraryPose = nil
    UI.applyLibraryPoseButton.Active = false
    UI.applyLibraryPoseButton.TextTransparency = 0.5
    local y = 0
    for _, pose in response.poses do
        local labelPrefix = pose.assetType == "snapshot" and "FULL BODY  ·  " or "POSE  ·  "
        local row = text(UI.poseList, "TextButton", labelPrefix .. pose.name .. "\n" .. tostring(pose.jointCount) .. " joints  ·  " .. table.concat(pose.joints, ", "), UDim2.fromOffset(0, y), UDim2.new(1, -5, 0, 42))
        row.Name = "Pose_" .. pose.id
        row.TextSize = 9
        row.TextXAlignment = Enum.TextXAlignment.Left
        row.TextTruncate = Enum.TextTruncate.AtEnd
        row.ZIndex = 10
        row:SetAttribute("PoseId", pose.id)
        setToolTip(row, string.format("%s · %s · %s", pose.description, pose.rigType, table.concat(pose.tags, ", ")))
        row.Activated:Connect(function()
            selectedLibraryPose = pose.id
            for _, candidate in UI.poseList:GetChildren() do
                if candidate:IsA("TextButton") then candidate.BackgroundColor3 = candidate == row and COLORS.accentSoft or COLORS.control end
            end
            UI.applyLibraryPoseButton.Active = true
            UI.applyLibraryPoseButton.TextTransparency = 0
            UI.status.Text = "Selected reusable pose: " .. pose.name .. ". Apply it to the selected key or another matching animation track."
        end)
        y += 46
    end
    UI.poseList.CanvasSize = UDim2.fromOffset(0, y)
    if y == 0 then
        local empty = text(UI.poseList, "TextLabel", "No saved poses match this search.", UDim2.fromOffset(4, 8), UDim2.new(1, -8, 0, 28))
        empty.BackgroundTransparency = 1
        empty.TextSize = 10
        empty.TextColor3 = COLORS.muted
        empty.ZIndex = 10
    end
end
UI.savePoseButton.Activated:Connect(function()
    local ok, err = pcall(function()
        local track = currentRecipe and selectedKeyTrackIndex and editableTracks()[selectedKeyTrackIndex]
        local key = track and selectedKeyIndex and track.keys[selectedKeyIndex]
        assert(connected, "Connect to the local Motion Tools server before saving a reusable pose.")
        assert(track and key, "Select a keyframe pose first.")
        local name = string.gsub(UI.poseNameBox.Text, "^%s*(.-)%s*$", "%1")
        assert(#name > 0, "Enter a name for this reusable pose.")
        local saved = request("/poses/save", {
            name = name,
            description = "Saved from " .. currentRecipe.name .. " at " .. string.format("%.3fs", key.time),
            tags = { "studio" },
            rigType = rigCompatibilityType(),
            transforms = { { joint = track.joint, position = key.position, rotation = key.rotation } },
        })
        UI.poseNameBox.Text = ""
        UI.status.Text = "Saved reusable pose '" .. saved.pose.name .. "' (" .. string.sub(saved.id, 1, 8) .. ")."
        if UI.poseLibraryPanel.Visible then refreshPoseLibrary() end
    end)
    if not ok then UI.status.Text = "Pose not saved: " .. tostring(err) end
end)
UI.captureSnapshotButton.Activated:Connect(function()
    local ok, err = pcall(function()
        assert(connected, "Connect to the local Motion Tools server before saving a snapshot.")
        assert(previewRigModel and viewportClone and currentRecipe, "Load a rig and animation before capturing a full-body snapshot.")
        local name = string.gsub(UI.poseNameBox.Text, "^%s*(.-)%s*$", "%1")
        assert(#name > 0, "Enter a name for this full-body snapshot.")
        local time = tonumber(UI.scrubber.Text)
        assert(time and time == time and math.abs(time) < math.huge, "Move the playhead to the pose you want to capture.")
        time = math.clamp(time, 0, currentRecipe.duration)
        local _, nodes, tracks = Authoring.tracks(viewportClone, currentRecipe, {})
        local transforms = {}
        for _, node in nodes do
            if node.target then
                local localPose = Authoring.sampleStack(tracks[node.name], time)
                local x, y, z = localPose:ToEulerAnglesXYZ()
                table.insert(transforms, { joint = node.name, position = { localPose.Position.X, localPose.Position.Y, localPose.Position.Z }, rotation = { math.deg(x), math.deg(y), math.deg(z) } })
            end
        end
        assert(#transforms > 0, "This rig has no driven joints to capture.")
        assert(#transforms <= 256, "This rig exceeds the 256-transform full-body snapshot limit.")
        local saved = request("/poses/save", {
            name = name,
            description = "Full-body viewport pose from " .. currentRecipe.name .. " at " .. string.format("%.3fs", time),
            tags = { "full-body", "studio" },
            rigType = rigCompatibilityType(),
            assetType = "snapshot",
            rigSignature = rigTopologySignature(previewRigModel),
            transforms = transforms,
        })
        UI.poseNameBox.Text = ""
        UI.status.Text = string.format("Captured '%s': %d driven joints at %.3fs. Snapshot is saved in the reusable pose library.", saved.pose.name, #transforms, time)
        if UI.poseLibraryPanel.Visible then refreshPoseLibrary() end
    end)
    if not ok then UI.status.Text = "Snapshot not captured: " .. tostring(err) end
end)
UI.openPoseLibraryButton.Activated:Connect(function()
    UI.poseLibraryPanel.Visible = not UI.poseLibraryPanel.Visible
    if UI.poseLibraryPanel.Visible then refreshPoseLibrary() end
end)
UI.closePoseLibraryButton.Activated:Connect(function() UI.poseLibraryPanel.Visible = false end)
UI.poseSearchBox.FocusLost:Connect(function(enterPressed)
    if enterPressed and UI.poseLibraryPanel.Visible then refreshPoseLibrary() end
end)
UI.applyLibraryPoseButton.Activated:Connect(function()
    local ok, err = pcall(function()
        assert(currentRecipe and selectedKeyIndex and selectedKeyTrackIndex, "Select an animation keyframe first.")
        assert(selectedLibraryPose and connected, "Select a saved pose while connected to the server.")
        local sourceTrack = editableTracks()[selectedKeyTrackIndex]
        local targetTime = sourceTrack.keys[selectedKeyIndex].time
        local poseAsset = request("/poses/read", { id = selectedLibraryPose })
        if poseAsset.pose.assetType == "snapshot" then
            assert(poseAsset.pose.rigSignature == rigTopologySignature(previewRigModel), "This full-body snapshot was captured on a different joint hierarchy. Choose a snapshot for the loaded rig.")
        end
        local applicable, addedKeys = {}, 0
        local addedTracks = 0
        for _, transform in poseAsset.pose.transforms do
            local track = nil
            for _, candidate in editableTracks() do if candidate.joint == transform.joint then track = candidate; break end end
            if track then
                local key = nil
                for _, candidate in track.keys do if math.abs(candidate.time - targetTime) <= 0.0001 then key = candidate; break end end
                if not key then
                    assert(targetTime > 0 and targetTime < currentRecipe.duration, "Pose can only add a key between the clip endpoints.")
                    assert(#track.keys < 128, transform.joint .. " already has 128 keys.")
                    addedKeys += 1
                end
                table.insert(applicable, { track = track, transform = transform })
            elseif poseAsset.pose.assetType == "snapshot" then
                addedTracks += 1
                addedKeys += targetTime > 0 and targetTime < currentRecipe.duration and 3 or 2
                table.insert(applicable, { track = { joint = transform.joint, keys = {} }, transform = transform, isNewTrack = true })
            end
        end
        assert(#applicable > 0, "The pose has no joints that match this animation's existing tracks.")
        assert(#editableTracks() + addedTracks <= 256, "Applying this snapshot would exceed 256 animation tracks in the active layer.")
        local totalKeys = 0
        for _, track in allRecipeTracks() do totalKeys += #track.keys end
        assert(totalKeys + addedKeys <= 4096, "Applying the pose would exceed the 4096-key animation limit.")
        pushUndoSnapshot()
        for _, item in applicable do
            local track, transform = item.track, item.transform
            if item.isNewTrack then
                local neutralStart = { time = 0, position = { 0, 0, 0 }, rotation = { 0, 0, 0 } }
                local neutralEnd = { time = currentRecipe.duration, position = { 0, 0, 0 }, rotation = { 0, 0, 0 } }
                track.keys = { neutralStart, neutralEnd }
                if targetTime > 0 and targetTime < currentRecipe.duration then
                    table.insert(track.keys, 2, { time = targetTime, position = { 0, 0, 0 }, rotation = { 0, 0, 0 } })
                end
                table.insert(editableTracks(), track)
            end
            local key = nil
            for _, candidate in track.keys do if math.abs(candidate.time - targetTime) <= 0.0001 then key = candidate; break end end
            if not key then
                    local pose = Authoring.sample(track, targetTime)
                    local x, y, z = pose:ToEulerAnglesXYZ()
                    key = { time = targetTime, position = { pose.Position.X, pose.Position.Y, pose.Position.Z }, rotation = { math.deg(x), math.deg(y), math.deg(z) } }
                    local insertIndex = #track.keys + 1
                    for keyIndex, candidate in track.keys do if candidate.time > targetTime then insertIndex = keyIndex; break end end
                    table.insert(track.keys, insertIndex, key)
            end
            key.position = { transform.position[1], transform.position[2], transform.position[3] }
            key.rotation = { transform.rotation[1], transform.rotation[2], transform.rotation[3] }
            if currentRecipe.loop and (targetTime == 0 or targetTime == currentRecipe.duration) then
                local other = targetTime == 0 and track.keys[#track.keys] or track.keys[1]
                other.position = table.clone(key.position)
                other.rotation = table.clone(key.rotation)
            end
        end
        local targetJoint = sourceTrack.joint
        UI.setRecipeDirty(true)
        refreshTimeline()
        local selectedTrackIndex, selectedKeyIndexAfter = nil, nil
        for trackIndex, track in editableTracks() do
            if track.joint == targetJoint then
                selectedTrackIndex = trackIndex
                for keyIndex, key in track.keys do if math.abs(key.time - targetTime) <= 0.0001 then selectedKeyIndexAfter = keyIndex; break end end
                break
            end
        end
        if selectedTrackIndex and selectedKeyIndexAfter then selectKey(selectedTrackIndex, selectedKeyIndexAfter) end
        UI.status.Text = string.format("Applied '%s' to %d matching joint(s) at %.3fs. Undo is available; save a revision to preserve it.", poseAsset.pose.name, #applicable, targetTime)
    end)
    if not ok then UI.status.Text = "Pose not applied: " .. tostring(err) end
end)
local function mirroredJointName(name)
    local leftStart = string.find(name, "Left", 1, true)
    local rightStart = string.find(name, "Right", 1, true)
    if leftStart and rightStart then return nil end
    if leftStart then return string.sub(name, 1, leftStart - 1) .. "Right" .. string.sub(name, leftStart + 4) end
    if rightStart then return string.sub(name, 1, rightStart - 1) .. "Left" .. string.sub(name, rightStart + 5) end
    return nil
end
UI.mirrorPoseButton.MouseButton1Click:Connect(function()
    local sourceTrack = currentRecipe and selectedKeyTrackIndex and editableTracks()[selectedKeyTrackIndex]
    local sourceKey = sourceTrack and selectedKeyIndex and sourceTrack.keys[selectedKeyIndex]
    if not sourceTrack or not sourceKey then UI.status.Text = "Select a keyframe pose before mirroring."; return end
    local targetName = mirroredJointName(sourceTrack.joint)
    if not targetName then
        UI.status.Text = "Mirror supports explicit Left/Right joint names only; this joint has no unambiguous side token."
        return
    end
    local targetTrackIndex, targetTrack
    for trackIndex, track in editableTracks() do
        if track.joint == targetName then targetTrackIndex, targetTrack = trackIndex, track; break end
    end
    if not targetTrack or not targetTrackIndex then
        UI.status.Text = "Matching joint " .. targetName .. " has no animation track. Add it before mirroring."
        return
    end
    if not previewRigModel then
        UI.status.Text = "Load the target rig in the Animation Studio viewport before mirroring."
        return
    end
    local profileOk, rigInspection = pcall(Rig.inspect, previewRigModel)
    if not profileOk or not rigInspection or not rigInspection.retargetProfile then
        UI.status.Text = "Could not read this rig's joint rest orientations; mirror was not applied."
        return
    end
    local sourceJoint, targetJoint
    for _, joint in rigInspection.retargetProfile.joints do
        if joint.name == sourceTrack.joint then sourceJoint = joint end
        if joint.name == targetName then targetJoint = joint end
    end
    if not sourceJoint or not sourceJoint.driven or not targetJoint or not targetJoint.driven then
        UI.status.Text = "Both mirrored joints must be driven joints on the loaded rig; mirror was not applied."
        return
    end
    local targetKeyIndex = KeyframeSelection.findKeyIndexAtTime(targetTrack.keys, sourceKey.time)
    local targetKey
    local insertedTargetKey = false
    local sampledTarget
    local insertionIndex
    if not targetKeyIndex then
        if #targetTrack.keys >= 128 then
            UI.status.Text = "The matching track already has the 128-key limit; mirror was not applied."
            return
        end
        local existingKeyCount = 0
        for _, track in currentRecipe.tracks do existingKeyCount += #track.keys end
        for _, layer in currentRecipe.layers or {} do
            for _, track in layer.tracks do existingKeyCount += #track.keys end
        end
        if currentRecipe.rootMotion then existingKeyCount += #currentRecipe.rootMotion.keys end
        if existingKeyCount >= 4096 then
            UI.status.Text = "The animation already has the 4096-key limit; mirror was not applied."
            return
        end
        insertionIndex = #targetTrack.keys + 1
        for keyIndex, key in targetTrack.keys do
            if key.time > sourceKey.time then insertionIndex = keyIndex; break end
        end
        local metadata, metadataError = KeyframeSelection.planMirrorInsertion(targetTrack.keys, insertionIndex)
        if not metadata then
            UI.status.Text = "Could not insert a mirrored key: " .. metadataError
            return
        end
        local sampleOk, sampled = pcall(Authoring.sample, targetTrack, sourceKey.time)
        if not sampleOk then
            UI.status.Text = "Could not sample the target track at this time: " .. tostring(sampled)
            return
        end
        sampledTarget = { transform = sampled, metadata = metadata }
        targetKeyIndex = insertionIndex
        insertedTargetKey = true
    end
    local mirrorOk, mirroredPosition, mirroredRotation = pcall(
        KeyframeSelection.Mirror.pose,
        sourceKey.position,
        sourceKey.rotation,
        sourceJoint.basis,
        targetJoint.basis
    )
    if not mirrorOk then
        UI.status.Text = "Could not calculate a safe rig-aware mirror pose: " .. tostring(mirroredPosition)
        return
    end
    pushUndoSnapshot()
    if insertedTargetKey then
        local position = sampledTarget.transform.Position
        local x, y, z = sampledTarget.transform:ToEulerAnglesXYZ()
        targetKey = {
            time = sourceKey.time,
            position = { position.X, position.Y, position.Z },
            rotation = { math.deg(x), math.deg(y), math.deg(z) },
            easingStyle = sampledTarget.metadata.easingStyle,
            easingDirection = sampledTarget.metadata.easingDirection,
            curve = sampledTarget.metadata.curve,
        }
        table.insert(targetTrack.keys, insertionIndex, targetKey)
    else
        targetKey = targetTrack.keys[targetKeyIndex]
    end
    targetKey.position = mirroredPosition
    targetKey.rotation = mirroredRotation
    if currentRecipe.loop and (targetKeyIndex == 1 or targetKeyIndex == #targetTrack.keys) then
        local matching = targetKeyIndex == 1 and targetTrack.keys[#targetTrack.keys] or targetTrack.keys[1]
        matching.position = table.clone(targetKey.position)
        matching.rotation = table.clone(targetKey.rotation)
    end
    UI.setRecipeDirty(true)
    updateHistoryButtons()
    selectKey(targetTrackIndex, targetKeyIndex)
    UI.status.Text = string.format("Mirrored %s → %s at %.2fs%s using rig rest orientations. Review the pose in the viewport; undo is available.", sourceTrack.joint, targetName, targetKey.time, insertedTargetKey and " (target key inserted)" or "")
end)
UI.pastePoseButton.MouseButton1Click:Connect(function()
    local track = currentRecipe and selectedKeyTrackIndex and editableTracks()[selectedKeyTrackIndex]
    local key = track and selectedKeyIndex and track.keys[selectedKeyIndex]
    if not track or not key or not poseClipboard then UI.status.Text = "Select a key and copy a pose first."; return end
    if poseClipboard.joint ~= track.joint then
        UI.status.Text = "Pose clipboard is for " .. poseClipboard.joint .. ". Copy a pose from " .. track.joint .. " first."
        return
    end
    pushUndoSnapshot()
    key.position = { poseClipboard.position[1], poseClipboard.position[2], poseClipboard.position[3] }
    key.rotation = { poseClipboard.rotation[1], poseClipboard.rotation[2], poseClipboard.rotation[3] }
    UI.setRecipeDirty(true)
    for axis = 1, 3 do
        positionBoxes[axis].Text = string.format("%.3f", key.position[axis])
        rotationBoxes[axis].Text = string.format("%.3f", key.rotation[axis])
    end
    showPose(key.time)
    updateHistoryButtons()
    UI.status.Text = "Pose pasted onto " .. track.joint .. ". Undo is available; save a revision to preserve it."
end)
local function restoreHistory(source, destination, action)
    local sourceBefore, destinationBefore = table.clone(source), table.clone(destination)
    local original = currentRecipe and {
        recipe = cloneRecipe(currentRecipe), layerId = activeLayerId, trackIndex = selectedKeyTrackIndex, keyIndex = selectedKeyIndex,
        selectedKeyIndices = captureSelectedKeyIndices(), reviewMarkers = cloneRecipe(reviewMarkers),
        selectedReviewMarker = selectedReviewMarker, selectedEventIndex = selectedEventIndex,
        playbackRangeIn = playbackRangeIn, playbackRangeOut = playbackRangeOut, previewLoop = previewLoop,
        timelineViewStart = timelineViewStart, timelineViewSpan = timelineViewSpan, dirty = recipeDirty,
        currentTime = tonumber(UI.scrubber.Text) or 0,
    } or nil
    local ok, err = pcall(function()
        assert(currentRecipe and #source > 0, "Nothing to " .. action:lower() .. ".")
        table.insert(destination, {
            recipe = cloneRecipe(currentRecipe),
            layerId = activeLayerId,
            trackIndex = selectedKeyTrackIndex,
            keyIndex = selectedKeyIndex,
            selectedKeyIndices = captureSelectedKeyIndices(),
            reviewMarkers = cloneRecipe(reviewMarkers),
            selectedReviewMarker = selectedReviewMarker,
            selectedEventIndex = selectedEventIndex,
            playbackRangeIn = playbackRangeIn,
            playbackRangeOut = playbackRangeOut,
            previewLoop = previewLoop,
            timelineViewStart = timelineViewStart,
            timelineViewSpan = timelineViewSpan,
        })
        if #destination > maximumUndoSteps then table.remove(destination, 1) end
        local snapshot = table.remove(source)
        currentRecipe = cloneRecipe(snapshot.recipe)
        activeLayerId = snapshot.layerId
        if activeLayerId and not selectedAnimationLayer() then activeLayerId = nil end
        selectedKeyTrackIndex, selectedKeyIndex = snapshot.trackIndex, snapshot.keyIndex
        if selectedKeyTrackIndex and not editableTracks()[selectedKeyTrackIndex] then
            selectedKeyTrackIndex, selectedKeyIndex = nil, nil
            table.clear(selectedKeys)
        end
        restoreSelectedKeyIndices(snapshot.selectedKeyIndices)
        table.clear(reviewMarkers)
        for _, marker in snapshot.reviewMarkers or {} do table.insert(reviewMarkers, marker) end
        selectedReviewMarker = snapshot.selectedReviewMarker
        selectedEventIndex = snapshot.selectedEventIndex
        playbackRangeIn, playbackRangeOut = snapshot.playbackRangeIn, snapshot.playbackRangeOut
        previewLoop = snapshot.previewLoop == nil and currentRecipe.loop or snapshot.previewLoop
        timelineViewStart, timelineViewSpan = snapshot.timelineViewStart, snapshot.timelineViewSpan
        updatePlaybackControls()
        local hasSelectedMarker = selectedReviewMarker ~= nil and reviewMarkers[selectedReviewMarker] ~= nil
        local selectedEvent = selectedEventIndex and currentRecipe.markers and currentRecipe.markers[selectedEventIndex]
        UI.reviewMarkerNameBox.Visible = hasSelectedMarker or selectedEvent ~= nil
        UI.reviewMarkerNameBox.Text = selectedEvent and selectedEvent.name or hasSelectedMarker and reviewMarkers[selectedReviewMarker].name or ""
        UI.removeMarkerButton.Active = hasSelectedMarker
        UI.removeMarkerButton.TextTransparency = hasSelectedMarker and 0 or 0.5
        UI.removeEventButton.Active = selectedEvent ~= nil
        UI.removeEventButton.TextTransparency = selectedEvent and 0 or 0.5
        UI.setRecipeDirty(true)
        refreshTimeline()
        refreshLayerPanel()
        if selectedKeyTrackIndex and selectedKeyIndex then
            selectKey(selectedKeyTrackIndex, selectedKeyIndex, true, true)
        else
            UI.keyEditor.Visible = false
            local time = math.clamp(tonumber(UI.scrubber.Text) or 0, 0, currentRecipe.duration)
            updatePlayhead(time)
            showPose(time)
        end
        updateHistoryButtons()
        UI.status.Text = action .. " complete. Save Revision to preserve this local draft."
    end)
    if not ok then
        if original then
            currentRecipe, activeLayerId = original.recipe, original.layerId
            selectedKeyTrackIndex, selectedKeyIndex = original.trackIndex, original.keyIndex
            selectedReviewMarker, selectedEventIndex = original.selectedReviewMarker, original.selectedEventIndex
            playbackRangeIn, playbackRangeOut = original.playbackRangeIn, original.playbackRangeOut
            previewLoop = original.previewLoop
            timelineViewStart, timelineViewSpan = original.timelineViewStart, original.timelineViewSpan
            table.clear(reviewMarkers)
            for _, marker in original.reviewMarkers do table.insert(reviewMarkers, marker) end
            table.clear(source)
            for _, entry in sourceBefore do table.insert(source, entry) end
            table.clear(destination)
            for _, entry in destinationBefore do table.insert(destination, entry) end
            recipeDirty = original.dirty
            UI.setRecipeDirty(original.dirty)
            pcall(function()
                restoreSelectedKeyIndices(original.selectedKeyIndices)
                updatePlaybackControls()
                refreshTimeline()
                refreshLayerPanel()
                refreshCurveGraph()
                if selectedKeyTrackIndex and selectedKeyIndex then selectKey(selectedKeyTrackIndex, selectedKeyIndex, true, true)
                else updatePlayhead(math.clamp(original.currentTime, 0, currentRecipe.duration)); showPose(math.clamp(original.currentTime, 0, currentRecipe.duration)) end
                updateHistoryButtons()
            end)
        end
        UI.status.Text = "Undo/redo was rolled back; the previous editor draft and history were restored. " .. tostring(err)
    end
end
UI.undoButton.MouseButton1Click:Connect(function() restoreHistory(undoStack, redoStack, "Undo") end)
UI.redoButton.MouseButton1Click:Connect(function() restoreHistory(redoStack, undoStack, "Redo") end)
updateHistoryButtons()
UI.copySelectedKeyframes = function()
    if not currentRecipe or not selectedKeyTrackIndex or not selectedKeyIndex then
        UI.status.Text = "Select one or more keyframes before copying."
        return
    end
    local copied, copyError = KeyframeSelection.copyKeyframes(editableTracks(), selectedKeys, selectedKeyTrackIndex, selectedKeyIndex)
    if not copied then UI.status.Text = copyError; return end
    KeyframeSelection.clipboard = copied
    UI.status.Text = string.format("Copied %d keyframe%s with timing and easing. Move the playhead and press Ctrl+V to paste.", #copied.entries, #copied.entries == 1 and "" or "s")
end
UI.pasteSelectedKeyframes = function()
    if not currentRecipe then UI.status.Text = "Load an animation before pasting keyframes."; return end
    if not KeyframeSelection.clipboard then UI.status.Text = "Copy one or more keyframes before pasting."; return end
    local targetTime = tonumber(UI.scrubber.Text)
    local existingKeyCount = 0
    for _, track in currentRecipe.tracks do existingKeyCount += #track.keys end
    for _, layer in currentRecipe.layers or {} do
        for _, track in layer.tracks do existingKeyCount += #track.keys end
    end
    if currentRecipe.rootMotion then existingKeyCount += #currentRecipe.rootMotion.keys end
    local plan, planError = KeyframeSelection.planKeyframePaste(editableTracks(), KeyframeSelection.clipboard,
        targetTime, currentRecipe.duration, 128, existingKeyCount, 4096)
    if not plan then UI.status.Text = planError; return end

    pushUndoSnapshot()
    local tracks = editableTracks()
    local pastedKeys = {}
    for _, item in plan do
        local track = tracks[item.trackIndex]
        table.insert(track.keys, item.key)
        table.sort(track.keys, function(left, right) return left.time < right.time end)
        table.insert(pastedKeys, { track = track, key = item.key, isAnchor = item.isAnchor })
    end
    table.clear(selectedKeys)
    local primaryTrackIndex, primaryKeyIndex
    for _, item in pastedKeys do
        selectedKeys[item.key] = true
        if item.isAnchor then
            primaryTrackIndex = table.find(tracks, item.track)
            primaryKeyIndex = table.find(item.track.keys, item.key)
        end
    end
    primaryTrackIndex = primaryTrackIndex or table.find(tracks, pastedKeys[1].track)
    primaryKeyIndex = primaryKeyIndex or table.find(pastedKeys[1].track.keys, pastedKeys[1].key)
    selectedKeyTrackIndex, selectedKeyIndex = primaryTrackIndex, primaryKeyIndex
    UI.setRecipeDirty(true)
    refreshTimeline()
    selectKey(primaryTrackIndex, primaryKeyIndex, true, true)
    updateKeySelectionAppearance()
    updateHistoryButtons()
    showPose(targetTime)
    UI.status.Text = string.format("Pasted %d keyframe%s at %.3fs with timing and easing preserved. Undo is available; save a revision to keep the edit.", #plan, #plan == 1 and "" or "s", targetTime)
end
local function isFiniteNumber(value)
    return type(value) == "number" and value == value and math.abs(value) < math.huge
end
local function validateAnimationDraft()
    local issues = {}
    local function issue(message) table.insert(issues, message) end
    local recipe = currentRecipe
    if type(recipe) ~= "table" or recipe.kind ~= "animation" then
        issue("Load an animation recipe first.")
        return false, issues
    end
    if type(recipe.name) ~= "string" or #recipe.name < 1 or #recipe.name > 80 or string.find(recipe.name, "%c") then issue("Animation name must be 1–80 characters without control characters.") end
    if not isFiniteNumber(recipe.duration) or recipe.duration < 0.1 or recipe.duration > 30 then issue("Duration must be between 0.1 and 30 seconds.") end
    if type(recipe.tracks) ~= "table" or #recipe.tracks < 1 or #recipe.tracks > 256 then issue("Animation must contain between 1 and 256 joint tracks.") end
    local tracks = type(recipe.tracks) == "table" and recipe.tracks or {}
    local seenJoints, totalKeys = {}, 0
    local function sameVector(left, right)
        if type(left) ~= "table" or type(right) ~= "table" or #left ~= 3 or #right ~= 3 then return false end
        return left[1] == right[1] and left[2] == right[2] and left[3] == right[3]
    end
    for _, track in tracks do
        if type(track) ~= "table" then issue("Animation contains an invalid joint track."); continue end
        local jointName = type(track.joint) == "string" and track.joint or "Unknown joint"
        if type(track.joint) ~= "string" or #track.joint < 1 or #track.joint > 80 or string.find(track.joint, "%c") then
            issue("Every track needs a valid joint name (1–80 characters).")
        elseif seenJoints[track.joint] then
            issue("Duplicate joint track: " .. track.joint .. ".")
        else
            seenJoints[track.joint] = true
        end
        local keys = type(track.keys) == "table" and track.keys or {}
        if #keys < 2 or #keys > 128 then issue(jointName .. " must have 2–128 keys.") end
        totalKeys += #keys
        local previousTime
        for keyIndex, key in keys do
            if type(key) ~= "table" then issue(jointName .. " contains an invalid key."); continue end
            if key.easingStyle ~= nil and not table.find({ "Linear", "Constant", "CubicV2", "Bounce", "Elastic", "Bezier" }, key.easingStyle) then
                issue(jointName .. " has an unsupported easing style.")
            end
            if key.easingDirection ~= nil and not table.find({ "In", "Out", "InOut" }, key.easingDirection) then
                issue(jointName .. " has an unsupported easing direction.")
            end
            if key.curve ~= nil then
                local curve = key.curve
                if type(curve) ~= "table"
                    or not isFiniteNumber(curve.outTime) or curve.outTime < 0 or curve.outTime > 1
                    or not isFiniteNumber(curve.inTime) or curve.inTime < 0 or curve.inTime > 1
                    or not isFiniteNumber(curve.outValue) or curve.outValue < -1 or curve.outValue > 2
                    or not isFiniteNumber(curve.inValue) or curve.inValue < -1 or curve.inValue > 2
                    or curve.outTime > curve.inTime then
                    issue(jointName .. " has invalid Bezier control handles.")
                end
            end
            local keyTime = key.time
            if not isFiniteNumber(keyTime) or keyTime < 0 or keyTime > 30 then
                issue(jointName .. " has a key time outside 0–30 seconds.")
            else
                if keyIndex == 1 and keyTime ~= 0 then issue(jointName .. " must start at 0 seconds.") end
                if previousTime and keyTime <= previousTime then issue(jointName .. " has key times that are not strictly increasing.") end
                previousTime = keyTime
            end
            for _, field in { "position", "rotation" } do
                local values = key[field]
                local limit = field == "position" and 100 or 720
                if type(values) ~= "table" or #values ~= 3 then
                    issue(jointName .. " has an invalid " .. field .. " vector.")
                else
                    for _, component in values do
                        if not isFiniteNumber(component) or math.abs(component) > limit then
                            issue(jointName .. " " .. field .. " values must be within ±" .. tostring(limit) .. ".")
                            break
                        end
                    end
                end
            end
        end
        if #keys >= 2 and isFiniteNumber(recipe.duration) then
            local first, last = keys[1], keys[#keys]
            if type(last) ~= "table" or last.time ~= recipe.duration then issue(jointName .. " must end at the clip duration.") end
            if recipe.loop then
                if type(first) == "table" and type(last) == "table" and (not sameVector(first.position, last.position) or not sameVector(first.rotation, last.rotation)) then
                    issue(jointName .. " loop start and end poses must match.")
                end
            end
        end
    end
    local layers = type(recipe.layers) == "table" and recipe.layers or {}
    if #layers > 32 then issue("Animation exceeds the 32-layer limit.") end
    local layerIds = {}
    for _, layer in layers do
        if type(layer) ~= "table" then issue("Animation contains an invalid layer."); continue end
        if type(layer.id) ~= "string" or #layer.id < 1 or layerIds[layer.id] then issue("Animation layers need unique IDs.") else layerIds[layer.id] = true end
        if type(layer.name) ~= "string" or #layer.name < 1 or #layer.name > 80 then issue("Animation layer names must be 1–80 characters.") end
        if layer.blendMode ~= "Override" and layer.blendMode ~= "Additive" then issue("Animation layer blend mode must be Override or Additive.") end
        if not isFiniteNumber(layer.weight) or layer.weight < 0 or layer.weight > 1 then issue("Animation layer weight must be between 0 and 1.") end
        if type(layer.enabled) ~= "boolean" then issue("Animation layer enabled state must be a boolean.") end
        local layerTracks = type(layer.tracks) == "table" and layer.tracks or {}
        if #layerTracks > 256 then issue(layer.name .. " exceeds the 256-track layer limit.") end
        local layerJoints = {}
        for _, track in layerTracks do
            if type(track) ~= "table" or type(track.keys) ~= "table" then issue(layer.name .. " contains an invalid joint track."); continue end
            if type(track.joint) ~= "string" or #track.joint < 1 or layerJoints[track.joint] then issue(layer.name .. " contains an invalid or duplicate joint track.") else layerJoints[track.joint] = true end
            totalKeys += #track.keys
            if #track.keys < 2 or #track.keys > 128 then issue(layer.name .. " tracks must contain 2–128 keys.") end
            local previousTime
            for index, key in track.keys do
                if type(key) ~= "table" or not isFiniteNumber(key.time) then issue(layer.name .. " contains an invalid key time."); continue end
                if index == 1 and key.time ~= 0 then issue(layer.name .. " tracks must start at 0 seconds.") end
                if previousTime and key.time <= previousTime then issue(layer.name .. " key times must increase strictly.") end
                previousTime = key.time
            end
            if #track.keys >= 2 and (track.keys[1].time ~= 0 or track.keys[#track.keys].time ~= recipe.duration) then issue(layer.name .. " tracks must span the full animation duration.") end
            if recipe.loop and #track.keys >= 2 and (not sameVector(track.keys[1].position, track.keys[#track.keys].position) or not sameVector(track.keys[1].rotation, track.keys[#track.keys].rotation)) then issue(layer.name .. " loop endpoints must match.") end
        end
    end
    local rootMotion = recipe.rootMotion
    if rootMotion ~= nil then
        if type(rootMotion) ~= "table" or type(rootMotion.joint) ~= "string" or type(rootMotion.keys) ~= "table" then
            issue("Root-motion channel needs a driven joint and a key track.")
        else
            local rootKeys = rootMotion.keys
            if #rootKeys < 2 or #rootKeys > 128 then issue("Root motion must have 2–128 keys.") end
            totalKeys += #rootKeys
            local previousTime
            for index, key in rootKeys do
                if type(key) ~= "table" or not isFiniteNumber(key.time) then issue("Root motion contains an invalid key time."); continue end
                if index == 1 and key.time ~= 0 then issue("Root motion must start at 0 seconds.") end
                if previousTime and key.time <= previousTime then issue("Root-motion key times must increase strictly.") end
                if key.time < 0 or key.time > recipe.duration then issue("Root-motion keys must stay inside the clip.") end
                previousTime = key.time
            end
            if #rootKeys >= 2 and (rootKeys[1].time ~= 0 or rootKeys[#rootKeys].time ~= recipe.duration) then issue("Root motion must span the full animation duration.") end
        end
    end
    local contacts = type(recipe.contacts) == "table" and recipe.contacts or {}
    if #contacts > 16 then issue("Animation exceeds the 16 declared contact-interval limit.") end
    for index, contact in contacts do
        if type(contact) ~= "table" or type(contact.effector) ~= "string" or (contact.kind ~= "support" and contact.kind ~= "grip") then
            issue("Animation contains an invalid contact interval.")
        elseif not isFiniteNumber(contact.start) or not isFiniteNumber(contact["end"]) or contact.start < 0 or contact.start >= contact["end"] or contact["end"] > recipe.duration then
            issue((contact.effector or "Contact") .. " interval must increase and stay within the clip.")
        end
        for otherIndex = index + 1, #contacts do
            local other = contacts[otherIndex]
            if type(contact) == "table" and type(other) == "table" and contact.effector == other.effector
                and isFiniteNumber(contact.start) and isFiniteNumber(contact["end"]) and isFiniteNumber(other.start) and isFiniteNumber(other["end"])
                and contact.start < other["end"] and other.start < contact["end"] then
                issue(contact.effector .. " contact intervals cannot overlap.")
            end
        end
    end
    if totalKeys > 4096 then issue("Animation exceeds the 4096-key limit across base tracks and layers.") end
    local markers = type(recipe.markers) == "table" and recipe.markers or {}
    if #markers > 100 then issue("Animation exceeds the 100 event-marker limit.") end
    for _, marker in markers do
        if type(marker) ~= "table" then issue("Animation contains an invalid event marker."); continue end
        if type(marker.name) ~= "string" or #marker.name < 1 or #marker.name > 80 then issue("Event marker names must be 1–80 characters.") end
        if not isFiniteNumber(marker.time) or marker.time < 0 or (isFiniteNumber(recipe.duration) and marker.time > recipe.duration) then issue("Event markers must be placed within the clip duration.") end
    end
    if previewRigModel then
        local rigOk, rigError = pcall(function() Authoring.tracks(previewRigModel, recipe, {}) end)
        if not rigOk then issue("Rig compatibility: " .. tostring(rigError)) end
    else
        issue("Load a rig in the Animation Studio before saving.")
    end
    return #issues == 0, issues
end
local function reportValidationIssues(action, issues)
    local first = issues[1] or "Unknown validation issue."
    UI.status.Text = action .. ": " .. first .. (#issues > 1 and string.format(" (+%d more; hover for details)", #issues - 1) or "")
    setToolTip(UI.status, table.concat(issues, "\n"))
end
local refreshRigList
local createRig
local availableRigs = {}
local function loadRigModel(model)
    local ok, err = pcall(function()
        assert(not recipeDirty, "Save Revision or Revert your current animation edits before switching rigs.")
        assert(model and model:IsA("Model"), "Choose a rig from the rig library.")
        Rig.setActive(model)
        stopEditorPlayback()
        previewRigModel = model
        currentRecipe = nil
        activeLayerId = nil
        selectedEventIndex = nil
        playbackRangeIn, playbackRangeOut = nil, nil
        timelineViewStart, timelineViewSpan = 0, nil
        updatePlaybackControls()
        table.clear(reviewMarkers)
        selectedReviewMarker = nil
        UI.reviewMarkerNameBox.Visible = false
        UI.reviewMarkerNameBox.Text = ""
        UI.removeMarkerButton.Active = false
        UI.removeMarkerButton.TextTransparency = 0.5
        UI.removeEventButton.Active = false
        UI.removeEventButton.TextTransparency = 0.5
        loadViewportRig(model)
        refreshTimeline()
        refreshLayerPanel()
        UI.selectedLabel.Text = "Rig ready: " .. model.Name
        UI.durationLabel.Text = "/ —"
        UI.status.Text = "Rig loaded in the animation viewport. Choose or create an animation, then review it here."
        UI.workflowHint.Text = "Active rig · " .. model.Name
        plugin:SetSetting("MotionActiveRig", model.Name)
        if refreshRigList then task.defer(refreshRigList) end
    end)
    if not ok then UI.status.Text = tostring(err) end
end
updatePlaybackControls = function()
    UI.loopPreviewButton.Text = previewLoop and "↻ On" or "↻ Off"
    UI.loopPreviewButton.BackgroundColor3 = previewLoop and COLORS.accentSoft or COLORS.control
    UI.playbackSpeedButton.Text = string.format("%.2g×", playbackSpeed)
    if playbackRangeIn or playbackRangeOut then
        UI.playbackRangeLabel.Text = string.format("RANGE  %.2f–%.2fs", playbackRangeIn or 0, playbackRangeOut or (currentRecipe and currentRecipe.duration or 0))
        setToolTip(UI.loopPreviewButton, previewLoop and "Loop the custom playback range" or "Play the custom range once; enable Loop to repeat")
    else
        UI.playbackRangeLabel.Text = "FULL CLIP"
        setToolTip(UI.loopPreviewButton, "Toggle looping for the full clip or custom playback range")
    end
    if UserInputService:GetFocusedTextBox() ~= UI.rangeInBox then
        UI.rangeInBox.Text = playbackRangeIn and string.format("%.3f", playbackRangeIn) or ""
    end
    if UserInputService:GetFocusedTextBox() ~= UI.rangeOutBox then
        UI.rangeOutBox.Text = playbackRangeOut and string.format("%.3f", playbackRangeOut) or ""
    end
end
local function setSelectedAnimation(asset, discardEdits)
    local ok, err = pcall(function()
        assert(connected, "Connect Motion Tools first.")
        assert(not recipeDirty or discardEdits, "Save Revision or Revert your current edits before loading another animation.")
        assert(asset and asset.recipe and asset.recipe.kind == "animation", "Choose a saved animation.")
        local model = Rig.active()
        assert(model, "Choose a rig in the Motion Tools rig library first.")
        stopEditorPlayback()
        previewRigModel = model
        loadViewportRig(model)
        currentRecipe = asset.recipe
        activeLayerId = nil
        selectedEventIndex = nil
        playbackRangeIn, playbackRangeOut = nil, nil
        timelineViewStart, timelineViewSpan = 0, nil
        updateViewportHud()
        table.clear(reviewMarkers)
        selectedReviewMarker = nil
        UI.removeEventButton.Active = false
        UI.removeEventButton.TextTransparency = 0.5
        UI.removeMarkerButton.Active = false
        UI.removeMarkerButton.TextTransparency = 0.5
        previewLoop = currentRecipe.loop
        updatePlaybackControls()
        UI.setRecipeDirty(false)
        table.clear(undoStack)
        table.clear(redoStack)
        updateHistoryButtons()
        selectedKeyTrackIndex, selectedKeyIndex = nil, nil
        table.clear(selectedKeys)
        UI.keyEditor.Visible = false
        refreshLayerPanel()
        selectedAssetId = asset.id
        selectedAssetIsEphemeral = asset.ephemeral == true
        selectedAssetParentId = asset.parentAssetId
        selectedSourceRigProfile = asset.sourceRigProfile
        selectedAssetFingerprint = asset.recipeFingerprint
        ephemeralBaseRecipe = selectedAssetIsEphemeral and cloneRecipe(asset.recipe) or nil
        if not selectedAssetIsEphemeral then plugin:SetSetting("MotionSelectedAnimation", asset.id) end
        if renderAnimationLibrary then renderAnimationLibrary() end
        UI.scrubber.Text = "0"
        UI.durationLabel.Text = string.format("/ %.2fs", currentRecipe.duration)
        UI.selectedLabel.Text = currentRecipe.name .. "  /  " .. string.sub(asset.id, 1, 8) .. (selectedAssetIsEphemeral and "  ·  CANDIDATE" or "")
        refreshTimeline()
        showPose(0)
        UI.status.Text = "Loaded on " .. model.Name .. ". Scrub the timeline or press Play."
    end)
    if not ok then UI.status.Text = tostring(err) end
end

local function renderRigList()
    local rigs = availableRigs
    for _, child in UI.rigList:GetChildren() do child:Destroy() end
    local query = UI.rigSearchBox.Text:lower():match("^%s*(.-)%s*$")
    local rowIndex = 0
    for _, model in rigs do
        if query == "" or model.Name:lower():find(query, 1, true) then
            rowIndex += 1
            local active = Rig.active() == model
            local humanoid = model:FindFirstChildOfClass("Humanoid")
            local rigTypeName = humanoid and humanoid.RigType.Name or "Custom"
            local row = Instance.new("TextButton")
            row.Name = "Rig_" .. tostring(rowIndex)
            row.Size = UDim2.new(1, -8, 0, 42)
            row.Position = UDim2.fromOffset(4, (rowIndex - 1) * 48)
            row.BackgroundColor3 = active and COLORS.accentSoft or COLORS.raised
            row.BorderSizePixel = 0
            row.Text = ""
            row.AutoButtonColor = false
            row.Parent = UI.rigList
            local rowCorner = Instance.new("UICorner")
            rowCorner.CornerRadius = UDim.new(0, 6)
            rowCorner.Parent = row
            local rowStroke = Instance.new("UIStroke")
            rowStroke.Color = active and COLORS.accent or COLORS.border
            rowStroke.Transparency = active and 0.32 or 0.78
            rowStroke.Thickness = 1
            rowStroke.Parent = row
            local nameLabel = text(row, "TextLabel", model.Name, UDim2.fromOffset(12, 4), UDim2.new(1, -76, 1, -8))
            nameLabel.BackgroundTransparency = 1
            nameLabel.TextSize = 13
            nameLabel.TextXAlignment = Enum.TextXAlignment.Left
            nameLabel.TextTruncate = Enum.TextTruncate.AtEnd
            local typeBadge = text(row, "TextLabel", rigTypeName, UDim2.new(1, -58, 0.5, -11), UDim2.fromOffset(48, 22))
            typeBadge.BackgroundColor3 = active and COLORS.accentSoft or COLORS.control
            typeBadge.TextColor3 = active and COLORS.accent or COLORS.muted
            typeBadge.TextSize = 10
            typeBadge.Font = FONTS.data
            if active then
                local marker = Instance.new("Frame")
                marker.Name = "ActiveMarker"
                marker.Size = UDim2.new(0, 3, 1, -10)
                marker.Position = UDim2.new(0, 1, 0, 5)
                marker.BackgroundColor3 = COLORS.accent
                marker.BorderSizePixel = 0
                marker.Parent = row
                local markerCorner = Instance.new("UICorner")
                markerCorner.CornerRadius = UDim.new(1, 0)
                markerCorner.Parent = marker
            end
            row.MouseEnter:Connect(function()
                TweenService:Create(row, TweenInfo.new(0.12), { BackgroundColor3 = active and COLORS.accentSoft or COLORS.controlHover }):Play()
            end)
            row.MouseLeave:Connect(function()
                TweenService:Create(row, TweenInfo.new(0.14), { BackgroundColor3 = active and COLORS.accentSoft or COLORS.raised }):Play()
            end)
            row.MouseButton1Click:Connect(function() loadRigModel(model) end)
        end
    end
    UI.rigList.CanvasSize = UDim2.fromOffset(0, rowIndex * 48)
    if rowIndex == 0 then
        local empty = text(UI.rigList, "TextLabel", query == "" and "No rigs yet. Add R15 or R6 to begin." or "No rigs match your search.", UDim2.fromOffset(6, 6), UDim2.new(1, -12, 0, 38))
        empty.BackgroundTransparency = 1
        empty.TextSize = 14
    end
end

refreshRigList = function()
    local rigs, seen = {}, {}
    for _, model in Rig.managedRigs() do
        table.insert(rigs, model)
        seen[model] = true
    end
    for _, item in workspace:GetDescendants() do
        local model
        if item:IsA("Humanoid") or Rig.isPartJoint(item) or item:IsA("Bone") then
            model = item:FindFirstAncestorOfClass("Model")
        end
        if model and not seen[model] then
            table.insert(rigs, model)
            seen[model] = true
        end
    end
    table.sort(rigs, function(a, b)
        local aManaged, bManaged = Rig.isManaged(a), Rig.isManaged(b)
        if aManaged ~= bManaged then return aManaged end
        return a.Name:lower() < b.Name:lower()
    end)
    availableRigs = rigs
    renderRigList()
end

local function managedRigsWithOtherFormat(rigType)
    local result = {}
    for _, model in Rig.managedRigs() do
        local humanoid = model:FindFirstChildOfClass("Humanoid")
        if humanoid and humanoid.RigType ~= rigType then table.insert(result, { model = model, rigType = humanoid.RigType }) end
    end
    return result
end

createRig = function(rigType, confirmedReplacement)
    if rigCreationPending then UI.status.Text = "A rig is already being created."; return end
    if RunService:IsRunning() then UI.status.Text = "Stop Play/Test mode before adding a rig."; return end
    if recipeDirty then UI.status.Text = "Save Revision or Revert your current animation edits before changing rigs."; return end
    local rigsToReplace = managedRigsWithOtherFormat(rigType)
    if #rigsToReplace > 0 and not confirmedReplacement then
        local oldFormat = rigsToReplace[1].rigType.Name
        pendingRigType = rigType
        UI.rigSwitchTitle.Text = "SWITCH TO " .. rigType.Name .. "?"
        UI.rigSwitchMessage.Text = string.format(
            "This replaces %d Motion Tools-managed %s rig(s) so the library stays organized. Animations saved with those rigs may become unavailable. Workspace and user-created rigs will not be touched. Continue?",
            #rigsToReplace,
            oldFormat
        )
        UI.confirmRigSwitchButton.Text = string.format("Replace %d rig%s", #rigsToReplace, #rigsToReplace == 1 and "" or "s")
        UI.rigSwitchModal.Visible = true
        return
    end
    local targetButton = rigType == Enum.HumanoidRigType.R15 and UI.createRigButton or UI.rigOptionsButton
    local originalText = targetButton.Text
    rigCreationPending = true
    UI.createRigButton.Active, UI.rigOptionsButton.Active = false, false
    targetButton.Active = false
    targetButton.Text = "Creating..."
    task.spawn(function()
        local ok, result = pcall(function()
            assert(not RunService:IsRunning(), "Stop Play/Test mode before adding a rig.")
            assert(not recipeDirty, "Save Revision or Revert your current animation edits before changing rigs.")
            local replacementTargets = managedRigsWithOtherFormat(rigType)
            assert(#replacementTargets == 0 or confirmedReplacement, "Confirm replacing the other managed rig format first.")
            local description = Instance.new("HumanoidDescription")
            local model
            local created, failure = pcall(function()
                model = Players:CreateHumanoidModelFromDescriptionAsync(description, rigType)
            end)
            description:Destroy()
            assert(created and model, failure or "Roblox could not create the rig.")
            local baseName = rigType.Name .. "_Rig"
            local suffix, name = 1, baseName
            while Rig.storageFolder():FindFirstChild(name) do
                suffix += 1
                name = baseName .. "_" .. tostring(suffix)
            end
            model.Name = name
            model.Parent = Rig.storageFolder()
            if #replacementTargets > 0 then ChangeHistoryService:SetWaypoint("Before replacing Motion Tools rig format") end
            for _, target in replacementTargets do target.model:Destroy() end
            Rig.setActive(model)
            ChangeHistoryService:SetWaypoint(#replacementTargets > 0 and "Replace Motion Tools rig format" or "Add " .. rigType.Name .. " Motion Tools rig")
            return model
        end)
        rigCreationPending = false
        UI.createRigButton.Active, UI.rigOptionsButton.Active = true, true
        targetButton.Active = true
        targetButton.Text = originalText
        if ok then
            refreshRigList()
            loadRigModel(result)
        else
            UI.status.Text = tostring(result)
            UI.workflowHint.Text = "Rig creation failed. See the status message below."
        end
    end)
end

UI.confirmRigSwitchButton.MouseButton1Click:Connect(function()
    local rigType = pendingRigType
    pendingRigType = nil
    UI.rigSwitchModal.Visible = false
    if rigType then createRig(rigType, true) end
end)
UI.cancelRigSwitchButton.MouseButton1Click:Connect(function()
    pendingRigType = nil
    UI.rigSwitchModal.Visible = false
end)

local function readVectorBoxes(boxes, limit, label)
    local result = {}
    for axis, box in boxes do
        local value = tonumber(box.Text)
        assert(value and value == value and math.abs(value) <= limit, label .. " values must be finite and within ±" .. tostring(limit) .. ".")
        result[axis] = value
    end
    return result
end
UI.applyKeyButton.MouseButton1Click:Connect(function()
    local ok, err = pcall(function()
        assert(currentRecipe and selectedKeyTrackIndex and selectedKeyIndex, "Select a keyframe first.")
        local track = editableTracks()[selectedKeyTrackIndex]
        local key = track and track.keys[selectedKeyIndex]
        assert(track and key, "The selected keyframe is no longer available.")
        local nextTime = tonumber(UI.keyTimeBox.Text)
        assert(nextTime and nextTime == nextTime and nextTime >= 0 and nextTime <= currentRecipe.duration, "Key time must be within the clip duration.")
        if selectedKeyIndex == 1 then
            assert(nextTime == 0, "The first key must stay at time 0.")
        elseif selectedKeyIndex == #track.keys then
            assert(nextTime == currentRecipe.duration, "The last key must stay at the clip duration.")
        else
            assert(nextTime > track.keys[selectedKeyIndex - 1].time and nextTime < track.keys[selectedKeyIndex + 1].time, "Move this key between its neighboring keys.")
        end
        local position = readVectorBoxes(positionBoxes, 100, "Position")
        local rotation = readVectorBoxes(rotationBoxes, 720, "Rotation")
        pushUndoSnapshot()
        key.time = nextTime
        key.position = position
        key.rotation = rotation
        if currentRecipe.loop and (selectedKeyIndex == 1 or selectedKeyIndex == #track.keys) then
            local matching = selectedKeyIndex == 1 and track.keys[#track.keys] or track.keys[1]
            matching.position = table.clone(position)
            matching.rotation = table.clone(rotation)
        end
        UI.setRecipeDirty(true)
        updatePlayhead(key.time)
        refreshTimeline()
        showPose(key.time)
        UI.status.Text = "Pose edited locally. Save Revision to preserve it; the original clip remains unchanged."
    end)
    if not ok then UI.status.Text = tostring(err) end
end)
UI.insertKeyButton.MouseButton1Click:Connect(function()
    local ok, err = pcall(function()
        assert(currentRecipe and selectedKeyTrackIndex, "Select a joint keyframe first.")
        local track = editableTracks()[selectedKeyTrackIndex]
        assert(track, "The selected joint track is no longer available.")
        assert(#track.keys < 128, track.joint .. " already has the maximum of 128 keys.")
        local totalKeys = 0
        for _, candidate in allRecipeTracks() do totalKeys += #candidate.keys end
        assert(totalKeys < 4096, "Animation already has the maximum of 4096 keys.")
        local time = tonumber(UI.scrubber.Text)
        assert(time and time == time and math.abs(time) < math.huge and time > 0 and time < currentRecipe.duration, "Move the playhead inside the clip to insert an interior key.")
        local insertionIndex = #track.keys + 1
        for keyIndex, key in track.keys do
            assert(math.abs(key.time - time) > 0.0005, "A key already exists at this time. Move the playhead between keys.")
            if key.time > time then insertionIndex = keyIndex; break end
        end
        local pose = Authoring.sample(track, time)
        local position = pose.Position
        local rotationX, rotationY, rotationZ = pose:ToEulerAnglesXYZ()
        pushUndoSnapshot()
        table.insert(track.keys, insertionIndex, {
            time = time,
            position = { position.X, position.Y, position.Z },
            rotation = { math.deg(rotationX), math.deg(rotationY), math.deg(rotationZ) },
        })
        UI.setRecipeDirty(true)
        updatePlayhead(time)
        selectKey(selectedKeyTrackIndex, insertionIndex)
        UI.status.Text = string.format("Inserted an interpolated key on %s at %.3fs. Save Revision to preserve it.", track.joint, time)
    end)
    if not ok then UI.status.Text = tostring(err) end
end)
UI.deleteKeyButton.MouseButton1Click:Connect(function()
    local ok, err = pcall(function()
        assert(currentRecipe and selectedKeyTrackIndex and selectedKeyIndex, "Select a keyframe first.")
        local track = editableTracks()[selectedKeyTrackIndex]
        assert(track and selectedKeyIndex > 1 and selectedKeyIndex < #track.keys, "Start and end keys are required; only interior keys can be deleted.")
        pushUndoSnapshot()
        table.remove(track.keys, selectedKeyIndex)
        UI.setRecipeDirty(true)
        selectedKeyTrackIndex, selectedKeyIndex = nil, nil
        table.clear(selectedKeys)
        UI.keyEditor.Visible = false
        refreshTimeline()
        showPose(tonumber(UI.scrubber.Text) or 0)
        UI.status.Text = "Key deleted locally. Save Revision to preserve the change; the original clip remains unchanged."
    end)
    if not ok then UI.status.Text = tostring(err) end
end)
UI.saveRevisionButton.MouseButton1Click:Connect(function()
    local valid, issues = validateAnimationDraft()
    if not valid then reportValidationIssues("Revision not saved", issues); return end
    local ok, err = pcall(function()
        assert(connected and currentRecipe and selectedAssetId, "Load an animation before saving a revision.")
        assert(recipeDirty, "No unsaved keyframe edits to save.")
        local parentId = selectedAssetIsEphemeral and selectedAssetParentId or selectedAssetId
        if selectedAssetIsEphemeral and selectedAssetParentId == nil then parentId = nil end
        local saveRequest = { recipe = currentRecipe, parentId = parentId }
        if selectedAssetIsEphemeral and selectedSourceRigProfile then saveRequest.sourceRigProfile = selectedSourceRigProfile end
        local saved = request("/library/save", saveRequest)
        selectedAssetId = saved.id
        currentRecipe = saved.recipe
        selectedAssetIsEphemeral = false
        selectedAssetParentId = nil
        selectedSourceRigProfile = saved.sourceRigProfile
        selectedAssetFingerprint = nil
        ephemeralBaseRecipe = nil
        UI.setRecipeDirty(false)
        table.clear(undoStack)
        table.clear(redoStack)
        updateHistoryButtons()
        plugin:SetSetting("MotionSelectedAnimation", saved.id)
        UI.selectedLabel.Text = currentRecipe.name .. "  /  " .. string.sub(saved.id, 1, 8)
        refreshTimeline()
        refreshLayerPanel()
        task.spawn(refreshLibrary)
        UI.status.Text = "Saved a new immutable revision. The original clip is preserved."
    end)
    if not ok then UI.status.Text = "Revision not saved: " .. tostring(err); setToolTip(UI.status, tostring(err)) end
end)
UI.revertButton.MouseButton1Click:Connect(function()
    local ok, err = pcall(function()
        assert(connected and selectedAssetId, "Load a saved animation first.")
        if selectedAssetIsEphemeral then
            assert(ephemeralBaseRecipe, "The unsaved candidate preview is no longer available. Reopen the candidate from the AI client.")
            setSelectedAnimation({ id = selectedAssetId, recipe = ephemeralBaseRecipe, ephemeral = true,
                parentAssetId = selectedAssetParentId, sourceRigProfile = selectedSourceRigProfile, recipeFingerprint = selectedAssetFingerprint }, true)
            return
        end
        local asset = request("/library/read", { id = selectedAssetId })
        setSelectedAnimation(asset, true)
    end)
    if not ok then UI.status.Text = "Could not reload saved revision: " .. tostring(err) end
end)
local function playEditorAnimation(effectCues, stopAfter)
    assert(currentRecipe and viewportClone, "Choose an animation and select a rig first.")
    stopEditorPlayback()
    local elapsed = tonumber(UI.scrubber.Text) or 0
    local rangeStart, rangeEnd
    local pingPongRange = false
    if transitionLoopEnabled then
        local track = selectedKeyTrackIndex and editableTracks()[selectedKeyTrackIndex]
        local key = track and selectedKeyIndex and track.keys[selectedKeyIndex]
        assert(track and key, "Select a joint key before playing its transition range.")
        rangeStart = track.keys[math.max(selectedKeyIndex - 1, 1)].time
        rangeEnd = track.keys[math.min(selectedKeyIndex + 1, #track.keys)].time
        assert(rangeEnd > rangeStart, "The selected key has no neighboring transition range to play.")
        pingPongRange = true
    else
        rangeStart = playbackRangeIn or 0
        rangeEnd = playbackRangeOut or currentRecipe.duration
    end
    if stopAfter and not previewLoop then rangeEnd = math.min(rangeEnd, stopAfter) end
    if elapsed < rangeStart or elapsed >= rangeEnd then elapsed = rangeStart end
    updatePlayhead(elapsed)
    showPose(elapsed)
    Preview.stop()
    if (effectCues and #effectCues > 0) or stopAfter then
        editorPreviewEffects = { cues = effectCues or {}, active = {}, elapsed = 0, firedCycle = {}, stopAfter = stopAfter }
    end
    local direction = 1
    playbackConnection = RunService.Heartbeat:Connect(function(delta)
        if not widget.Enabled or not currentRecipe or not viewportClone then stopEditorPlayback(); return end
        if pingPongRange then
            elapsed += delta * playbackSpeed * direction
            while elapsed > rangeEnd or elapsed < rangeStart do
                if elapsed > rangeEnd then
                    elapsed = rangeEnd - (elapsed - rangeEnd)
                    direction = -1
                elseif elapsed < rangeStart then
                    elapsed = rangeStart + (rangeStart - elapsed)
                    direction = 1
                end
            end
        else
            elapsed += delta * playbackSpeed
            if elapsed >= rangeEnd then
                if previewLoop then
                    elapsed = rangeStart + ((elapsed - rangeStart) % (rangeEnd - rangeStart))
                else
                    elapsed = rangeEnd
                end
            end
        end
        updatePlayhead(elapsed)
        showPose(elapsed)
        updateEditorPreviewEffects(elapsed, delta)
        if not pingPongRange and not previewLoop and elapsed >= rangeEnd then stopEditorPlayback() end
    end)
    updatePlaybackToggle(true)
end
local function playEditorEffectsOnly(effectCues, stopAfter)
    assert(viewportClone and previewRigModel, "Load a rig in the Animation Studio viewport before previewing VFX.")
    stopEditorPlayback()
    editorPreviewEffects = { cues = effectCues, active = {}, elapsed = 0, firedCycle = {}, stopAfter = stopAfter }
    local elapsed = 0
    playbackConnection = RunService.Heartbeat:Connect(function(delta)
        if not widget.Enabled or not viewportClone then stopEditorPlayback(); return end
        elapsed += delta * playbackSpeed
        updateEditorPreviewEffects(elapsed, delta)
    end)
    updatePlaybackToggle(true)
end
local function stepToKey(direction)
    if not currentRecipe then UI.status.Text = "Load an animation before stepping through keys."; return end
    local currentTime = tonumber(UI.scrubber.Text) or 0
    local times, seen = {}, {}
    for _, track in allRecipeTracks() do
        for _, key in track.keys do
            local identity = string.format("%.4f", key.time)
            if not seen[identity] then
                seen[identity] = true
                table.insert(times, key.time)
            end
        end
    end
    table.sort(times)
    local target = direction < 0 and 0 or currentRecipe.duration
    if direction < 0 then
        for _, time in times do if time < currentTime - 0.0005 then target = time else break end end
    else
        for _, time in times do if time > currentTime + 0.0005 then target = time; break end end
    end
    stopEditorPlayback()
    updatePlayhead(target)
    showPose(target)
end
local function stepFrame(direction)
    if not currentRecipe then UI.status.Text = "Load an animation before stepping by frame."; return end
    local frameRate = playbackFrameRates[playbackFrameRateIndex]
    local currentTime = tonumber(UI.scrubber.Text) or 0
    local currentFrame = math.floor(currentTime * frameRate + 0.0001)
    local lastFrame = math.floor(currentRecipe.duration * frameRate + 0.5)
    local targetFrame = math.clamp(currentFrame + direction, 0, lastFrame)
    local targetTime = math.min(targetFrame / frameRate, currentRecipe.duration)
    stopEditorPlayback()
    updatePlayhead(targetTime)
    showPose(targetTime)
    UI.status.Text = string.format("Frame %d / %d · %.3fs · %d fps", targetFrame, lastFrame, targetTime, frameRate)
end
local playbackSpeeds = { 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2 }
local function cyclePlaybackSpeed()
    local index = 1
    for i, speed in playbackSpeeds do if speed == playbackSpeed then index = i; break end end
    playbackSpeed = playbackSpeeds[index % #playbackSpeeds + 1]
    updatePlaybackControls()
end
UI.previousKeyButton.MouseButton1Click:Connect(function() stepToKey(-1) end)
UI.nextKeyButton.MouseButton1Click:Connect(function() stepToKey(1) end)
UI.previousFrameButton.MouseButton1Click:Connect(function() stepFrame(-1) end)
UI.nextFrameButton.MouseButton1Click:Connect(function() stepFrame(1) end)
local function toggleEditorPlayback()
    if playbackConnection then
        stopEditorPlayback()
        Preview.stop()
        UI.status.Text = "Playback stopped."
        return
    end
    local ok, err = pcall(function()
        assert(not RunService:IsRunning(), "Stop Play/Test mode before previewing.")
        playEditorAnimation()
        UI.status.Text = transitionLoopEnabled and "Ping-ponging the selected joint's neighboring-key range." or "Playing " .. currentRecipe.name .. " in the animation viewport."
    end)
    if not ok then UI.status.Text = tostring(err) end
end
UI.transitionLoopButton.MouseButton1Click:Connect(function()
    transitionLoopEnabled = not transitionLoopEnabled
    UI.transitionLoopButton.Text = transitionLoopEnabled and "Range · On" or "Range · Off"
    UI.transitionLoopButton.BackgroundColor3 = transitionLoopEnabled and COLORS.accentSoft or COLORS.control
    if playbackConnection then stopEditorPlayback() end
    UI.status.Text = transitionLoopEnabled and "Select a key and press Play to ping-pong through its neighboring poses." or "Whole-clip playback mode restored."
end)
playbackToggleButton.MouseButton1Click:Connect(toggleEditorPlayback)
UI.shortcutConnection = UserInputService.InputBegan:Connect(function(input, gameProcessed)
    if gameProcessed or not widget.Enabled or UserInputService:GetFocusedTextBox() then return end
    local pointer = UI.pointerPosition()
    if UI.rigSwitchModal.Visible or not UI.pointInside(UI.editor, pointer) or UI.pointInside(UI.library, pointer) then return end
    local controlHeld = UserInputService:IsKeyDown(Enum.KeyCode.LeftControl) or UserInputService:IsKeyDown(Enum.KeyCode.RightControl)
    if controlHeld and input.KeyCode == Enum.KeyCode.C then
        UI.copySelectedKeyframes()
    elseif controlHeld and input.KeyCode == Enum.KeyCode.V then
        UI.pasteSelectedKeyframes()
    elseif input.KeyCode == Enum.KeyCode.Q then
        setGizmoMode("Select")
    elseif input.KeyCode == Enum.KeyCode.G then
        setGizmoMode("Move")
    elseif input.KeyCode == Enum.KeyCode.R then
        setGizmoMode("Rotate")
    elseif input.KeyCode == Enum.KeyCode.I then
        setGizmoMode("IK")
    elseif input.KeyCode == Enum.KeyCode.Space then
        toggleEditorPlayback()
    elseif input.KeyCode == Enum.KeyCode.Left then
        if UserInputService:IsKeyDown(Enum.KeyCode.LeftShift) or UserInputService:IsKeyDown(Enum.KeyCode.RightShift) then
            stepFrame(-1)
        else
            stepToKey(-1)
        end
    elseif input.KeyCode == Enum.KeyCode.Right then
        if UserInputService:IsKeyDown(Enum.KeyCode.LeftShift) or UserInputService:IsKeyDown(Enum.KeyCode.RightShift) then
            stepFrame(1)
        else
            stepToKey(1)
        end
    elseif input.KeyCode == Enum.KeyCode.F and viewportClone then
        local pointer = UI.pointerPosition()
        local viewPosition, viewSize = UI.viewport.AbsolutePosition, UI.viewport.AbsoluteSize
        local overViewport = pointer.X >= viewPosition.X and pointer.X <= viewPosition.X + viewSize.X and pointer.Y >= viewPosition.Y and pointer.Y <= viewPosition.Y + viewSize.Y
        if overViewport then frameViewportRig() end
    elseif currentRecipe and (input.KeyCode == Enum.KeyCode.Home or input.KeyCode == Enum.KeyCode.End) then
        stopEditorPlayback()
        local time = input.KeyCode == Enum.KeyCode.Home and 0 or currentRecipe.duration
        updatePlayhead(time)
        showPose(time)
    end
end)
UI.loopPreviewButton.MouseButton1Click:Connect(function()
    previewLoop = not previewLoop
    updatePlaybackControls()
end)
UI.setRangeInButton.MouseButton1Click:Connect(function()
    if not currentRecipe then UI.status.Text = "Load an animation before setting a playback range."; return end
    stopEditorPlayback()
    playbackRangeIn = math.clamp(tonumber(UI.scrubber.Text) or 0, 0, currentRecipe.duration)
    if playbackRangeOut and playbackRangeOut <= playbackRangeIn then playbackRangeOut = nil end
    updatePlaybackControls()
    refreshTimeline()
    UI.status.Text = string.format("Playback In set to %.3fs. Set Out later in the clip, then enable Loop to repeat the range.", playbackRangeIn)
end)
UI.setRangeOutButton.MouseButton1Click:Connect(function()
    if not currentRecipe then UI.status.Text = "Load an animation before setting a playback range."; return end
    local time = math.clamp(tonumber(UI.scrubber.Text) or 0, 0, currentRecipe.duration)
    if not playbackRangeIn then UI.status.Text = "Set In first, then move the playhead forward and set Out."; return end
    if time <= playbackRangeIn then UI.status.Text = "Playback Out must be later than In."; return end
    stopEditorPlayback()
    playbackRangeOut = time
    updatePlaybackControls()
    refreshTimeline()
    UI.status.Text = string.format("Playback range %.3f–%.3fs. Enable Loop to repeat it.", playbackRangeIn, playbackRangeOut)
end)
UI.clearPlaybackRangeButton.MouseButton1Click:Connect(function()
    stopEditorPlayback()
    playbackRangeIn, playbackRangeOut = nil, nil
    updatePlaybackControls()
    refreshTimeline()
    UI.status.Text = "Custom playback range cleared; the full clip is active."
end)
local function applyPlaybackRangeInput(box, kind)
    if not currentRecipe then UI.status.Text = "Load an animation before editing a playback range."; updatePlaybackControls(); return end
    local raw = string.match(box.Text, "^%s*(.-)%s*$") or ""
    if raw == "" then
        if kind == "In" then playbackRangeIn, playbackRangeOut = nil, nil else playbackRangeOut = nil end
        stopEditorPlayback()
        updatePlaybackControls()
        refreshTimeline()
        UI.status.Text = "Playback range field cleared."
        return
    end
    local time = tonumber(raw)
    if not time or time ~= time or math.abs(time) == math.huge or time < 0 or time > currentRecipe.duration then
        UI.status.Text = string.format("Playback %s must be between 0 and %.3f seconds.", kind, currentRecipe.duration)
        updatePlaybackControls()
        return
    end
    if kind == "In" then
        if playbackRangeOut and time >= playbackRangeOut then
            UI.status.Text = "Playback In must be earlier than Out."
            updatePlaybackControls()
            return
        end
        playbackRangeIn = time
    else
        if not playbackRangeIn then
            UI.status.Text = "Set In first, or leave Out blank to use the clip end."
            updatePlaybackControls()
            return
        end
        if time <= playbackRangeIn then
            UI.status.Text = "Playback Out must be later than In."
            updatePlaybackControls()
            return
        end
        playbackRangeOut = time
    end
    stopEditorPlayback()
    updatePlaybackControls()
    refreshTimeline()
    UI.status.Text = string.format("Playback range: %.3f–%.3fs.", playbackRangeIn or 0, playbackRangeOut or currentRecipe.duration)
end
UI.rangeInBox.FocusLost:Connect(function() applyPlaybackRangeInput(UI.rangeInBox, "In") end)
UI.rangeOutBox.FocusLost:Connect(function() applyPlaybackRangeInput(UI.rangeOutBox, "Out") end)
UI.playbackSpeedButton.MouseButton1Click:Connect(cyclePlaybackSpeed)
updatePlaybackControls()

local timelineScrubbing = false
local function snapTimelineTime(rawTime, minimumTime, maximumTime, width, ignoredKeys)
    if not timelineSnapEnabled then return rawTime, nil end
    local viewStart, viewEnd = timelineViewBounds(currentRecipe.duration)
    local tolerance = math.max(0.01, (viewEnd - viewStart) * 10 / math.max(width, 1))
    local nearestTime, nearestDelta, snapLabel = rawTime, math.huge, nil
    local function considerSnap(time, label, force)
        if time < minimumTime or time > maximumTime then return end
        local delta = math.abs(time - rawTime)
        if (force or delta <= tolerance) and delta < nearestDelta then
            nearestTime, nearestDelta, snapLabel = time, delta, label
        end
    end
    local gridStep = timelineFrameSnapEnabled and (1 / playbackFrameRates[playbackFrameRateIndex]) or timelineSnapStep
    local gridTime = math.floor(rawTime / gridStep + 0.5) * gridStep
    considerSnap(gridTime, timelineFrameSnapEnabled and string.format("%d fps frame", playbackFrameRates[playbackFrameRateIndex]) or string.format("%.2fs beat", gridTime), timelineFrameSnapEnabled)
    for _, track in allRecipeTracks() do
        for _, key in track.keys do if not ignoredKeys or not ignoredKeys[key] then considerSnap(key.time, track.joint .. " key") end end
    end
    for _, marker in currentRecipe.markers or {} do considerSnap(marker.time, marker.name .. " event") end
    for _, marker in reviewMarkers do considerSnap(marker.time, marker.name .. " review") end
    return snapLabel and nearestTime or rawTime, snapLabel
end
local function updateDraggedRangeHandle(screenX)
    if not draggingRangeHandle or not currentRecipe then return end
    local width = math.max(UI.trackArea.AbsoluteSize.X, 1)
    local alpha = math.clamp((screenX - UI.trackArea.AbsolutePosition.X - 8) / math.max(width - 16, 1), 0, 1)
    local rawTime = timelineAlphaToTime(alpha, currentRecipe.duration)
    local minimumGap = math.max(0.01, currentRecipe.duration * 0.002)
    local minimumTime, maximumTime
    if draggingRangeHandle == "In" then
        minimumTime = 0
        maximumTime = (playbackRangeOut or currentRecipe.duration) - minimumGap
    else
        minimumTime = (playbackRangeIn or 0) + minimumGap
        maximumTime = currentRecipe.duration
    end
    if maximumTime <= minimumTime then return end
    local newTime, snapLabel = snapTimelineTime(rawTime, minimumTime, maximumTime, width)
    newTime = math.clamp(newTime, minimumTime, maximumTime)
    if draggingRangeHandle == "In" then playbackRangeIn = newTime else playbackRangeOut = newTime end
    draggingRangeHandleSnapLabel = snapLabel
    updatePlaybackControls()
    refreshTimeline()
end
local function updateDraggedKey(screenX)
    if not draggingKey or not currentRecipe then return end
    local track = editableTracks()[draggingKey.trackIndex]
    local key = track and track.keys[draggingKey.keyIndex]
    if not key then return end
    local width = math.max(UI.trackArea.AbsoluteSize.X, 1)
    local viewStart, viewEnd = timelineViewBounds(currentRecipe.duration)
    local requestedDelta = (screenX - draggingKey.pointerStartX) * (viewEnd - viewStart) / math.max(width - 16, 1)
    local rawAnchorTime = math.clamp(draggingKey.anchorTime + requestedDelta, 0, currentRecipe.duration)
    local snappedAnchorTime, snapLabel = snapTimelineTime(rawAnchorTime, 0, currentRecipe.duration, width, selectedKeys)
    requestedDelta = snappedAnchorTime - draggingKey.anchorTime
    local plan, planError = KeyframeSelection.planRetiming(editableTracks(), selectedKeys, draggingKey.originalTimes, requestedDelta)
    if not plan then draggingKey.error = planError; return end
    if math.abs(plan.delta) < 0.0001 and not draggingKey.moved then
        draggingKey.snapLabel = snapLabel
        draggingKey.clamped = plan.clamped
        return
    end
    if not draggingKey.moved then
        pushUndoSnapshot()
        draggingKey.moved = true
    end
    draggingKey.snapLabel = snapLabel
    draggingKey.clamped = plan.clamped
    draggingKey.affectedTrackCount = plan.affectedTrackCount
    for selectedKey, originalTime in pairs(draggingKey.originalTimes) do
        selectedKey.time = originalTime + plan.delta
        local markerEntry = keyMarkerByKey[selectedKey]
        local marker = markerEntry and markerEntry.marker
        if marker and marker.Parent then
            local markerAlpha = math.clamp(timelineTimeToAlpha(selectedKey.time, currentRecipe.duration), 0, 1)
            marker.Position = UDim2.new(markerAlpha, 8 - markerAlpha * 16, 0.5, 0)
            local selectedTrack = editableTracks()[markerEntry.trackIndex]
            setToolTip(marker, string.format("%s · %.2fs · selected group", selectedTrack.joint, selectedKey.time))
        end
    end
    UI.setRecipeDirty(true)
    UI.keyTimeBox.Text = string.format("%.3f", key.time)
    UI.keyTimeRangeHint.TextColor3 = COLORS.accent
    UI.keyTimeRangeHint.Text = string.format("Group · %d keys across %d tracks", plan.selectedCount, plan.affectedTrackCount)
    if not draggingKey.curveRefreshAt or os.clock() - draggingKey.curveRefreshAt >= 0.08 then
        draggingKey.curveRefreshAt = os.clock()
        refreshTimeline()
    end
    updatePlayhead(key.time)
    showPose(key.time)
end
UI.updateDraggedSemanticKey = function(screenX)
    local drag = draggingSemanticKey
    if not drag or not currentRecipe then return end
    local item = drag.kind == "rootMotion" and currentRecipe.rootMotion and currentRecipe.rootMotion.keys[drag.index] or drag.kind == "event" and currentRecipe.markers and currentRecipe.markers[drag.index]
    if not item then draggingSemanticKey = nil; return end
    local lower, upper = 0, currentRecipe.duration
    if drag.kind == "rootMotion" then
        local keys = currentRecipe.rootMotion.keys
        if drag.index <= 1 or drag.index >= #keys then return end
        lower = keys[drag.index - 1].time + 0.001
        upper = keys[drag.index + 1].time - 0.001
    end
    if upper <= lower then return end
    local width = math.max(UI.trackArea.AbsoluteSize.X, 1)
    local alpha = math.clamp((screenX - UI.trackArea.AbsolutePosition.X - 8) / math.max(width - 16, 1), 0, 1)
    local rawTime = math.clamp(timelineAlphaToTime(alpha, currentRecipe.duration), lower, upper)
    local nextTime, snapLabel = snapTimelineTime(rawTime, lower, upper, width)
    nextTime = math.clamp(nextTime, lower, upper)
    if math.abs(nextTime - item.time) < 0.0001 then return end
    if not drag.moved then pushUndoSnapshot(); drag.moved = true end
    drag.snapLabel = snapLabel
    item.time = nextTime
    UI.setRecipeDirty(true)
    local markerAlpha = math.clamp(timelineTimeToAlpha(nextTime, currentRecipe.duration), 0, 1)
    drag.marker.Position = UDim2.new(markerAlpha, 8 - markerAlpha * 16, 0.5, 0)
    setToolTip(drag.marker, string.format("%s · %.3fs · drag to retime", drag.kind == "event" and item.name or ("Root motion · " .. currentRecipe.rootMotion.joint), nextTime))
    updatePlayhead(nextTime)
    showPose(nextTime)
end
UI.updateDraggedContactHandle = function(screenX)
    local drag = draggingContactHandle
    if not drag or not currentRecipe then return end
    local contact = currentRecipe.contacts and currentRecipe.contacts[drag.index]
    if not contact then draggingContactHandle = nil; return end
    local minimumTime, maximumTime
    if drag.edge == "start" then
        minimumTime, maximumTime = 0, contact["end"] - 0.01
        for index, other in currentRecipe.contacts do
            if index ~= drag.index and other.effector == contact.effector then
                if other["end"] <= contact.start then minimumTime = math.max(minimumTime, other["end"]) end
                if other.start >= contact.start then maximumTime = math.min(maximumTime, other.start - 0.01) end
            end
        end
    else
        minimumTime, maximumTime = contact.start + 0.01, currentRecipe.duration
        for index, other in currentRecipe.contacts do
            if index ~= drag.index and other.effector == contact.effector and other.start >= contact["end"] then maximumTime = math.min(maximumTime, other.start) end
        end
    end
    if maximumTime <= minimumTime then return end
    local width = math.max(UI.trackArea.AbsoluteSize.X, 1)
    local alpha = math.clamp((screenX - UI.trackArea.AbsolutePosition.X - 8) / math.max(width - 16, 1), 0, 1)
    local rawTime = timelineAlphaToTime(alpha, currentRecipe.duration)
    local newTime = math.clamp(rawTime, minimumTime, maximumTime)
    local currentTime = drag.edge == "start" and contact.start or contact["end"]
    if math.abs(newTime - currentTime) < 0.0001 then return end
    if not drag.moved then pushUndoSnapshot(); drag.moved = true end
    if drag.edge == "start" then contact.start = newTime else contact["end"] = newTime end
    UI.setRecipeDirty(true)
    local startAlpha = math.clamp(timelineTimeToAlpha(contact.start, currentRecipe.duration), 0, 1)
    local endAlpha = math.clamp(timelineTimeToAlpha(contact["end"], currentRecipe.duration), 0, 1)
    drag.band.Position = UDim2.new(startAlpha, 8 - startAlpha * 16, drag.band.Position.Y.Scale, drag.band.Position.Y.Offset)
    drag.band.Size = UDim2.new(endAlpha - startAlpha, -1, 0, 9)
    setToolTip(drag.band, string.format("%s · %s · %.3f–%.3fs · drag either edge to retime", contact.effector, contact.kind, contact.start, contact["end"]))
    local previewTime = (contact.start + contact["end"]) / 2
    updatePlayhead(previewTime)
    showPose(previewTime)
end
local function seekTimeline(screenX)
    if not currentRecipe then return end
    local width = math.max(UI.trackArea.AbsoluteSize.X, 1)
    local alpha = math.clamp((screenX - UI.trackArea.AbsolutePosition.X - 8) / math.max(width - 16, 1), 0, 1)
    local time = math.clamp(timelineAlphaToTime(alpha, currentRecipe.duration), 0, currentRecipe.duration)
    updatePlayhead(time)
    if playbackConnection then stopEditorPlayback() end
    showPose(time)
end
UI.playhead.InputBegan:Connect(function(input)
    if input.UserInputType ~= Enum.UserInputType.MouseButton1 then return end
    timelineScrubbing = true
    seekTimeline(UI.pointerPosition().X)
end)
local function zoomTimeline(factor, pointerX)
    if not currentRecipe then return end
    local duration = currentRecipe.duration
    local startTime, endTime = timelineViewBounds(duration)
    local currentSpan = endTime - startTime
    local rulerWidth = math.max(UI.ruler.AbsoluteSize.X, 1)
    local anchorRatio = math.clamp((pointerX - UI.ruler.AbsolutePosition.X) / rulerWidth, 0, 1)
    local anchorTime = startTime + currentSpan * anchorRatio
    local minimumSpan = math.min(duration, 0.05)
    local newSpan = math.clamp(currentSpan / factor, minimumSpan, duration)
    timelineViewSpan = newSpan
    timelineViewStart = math.clamp(anchorTime - newSpan * anchorRatio, 0, duration - newSpan)
    refreshTimeline()
end
local function panTimeline(wheelDelta)
    if not currentRecipe then return end
    local startTime, endTime = timelineViewBounds(currentRecipe.duration)
    local span = endTime - startTime
    timelineViewSpan = span
    timelineViewStart = math.clamp(startTime - wheelDelta * span * 0.12, 0, currentRecipe.duration - span)
    refreshTimeline()
end
local function fitTimelineToRange()
    if not currentRecipe then return end
    local startTime = playbackRangeIn or 0
    local endTime = playbackRangeOut or currentRecipe.duration
    if endTime <= startTime then startTime, endTime = 0, currentRecipe.duration end
    timelineViewStart, timelineViewSpan = startTime, endTime - startTime
    refreshTimeline()
end
local function resetTimelineZoom()
    if not currentRecipe then return end
    timelineViewStart, timelineViewSpan = 0, currentRecipe.duration
    refreshTimeline()
end
UI.timelineFitButton.MouseButton1Click:Connect(function()
    if not currentRecipe then UI.status.Text = "Load an animation before fitting the timeline."; return end
    fitTimelineToRange()
    UI.status.Text = (playbackRangeIn or playbackRangeOut) and "Timeline fitted to the playback range." or "Timeline fitted to the full clip."
end)
UI.timelineResetZoomButton.MouseButton1Click:Connect(function()
    if not currentRecipe then UI.status.Text = "Load an animation before resetting timeline zoom."; return end
    resetTimelineZoom()
    UI.status.Text = "Timeline zoom reset to show the full clip."
end)
UI.trackArea.InputBegan:Connect(function(input)
    if input.UserInputType == Enum.UserInputType.MouseButton1 then
        timelineScrubbing = true
        seekTimeline(UI.pointerPosition().X)
    end
end)
UI.timelineInputConnection = UserInputService.InputChanged:Connect(function(input)
    if input.UserInputType == Enum.UserInputType.MouseWheel and currentRecipe then
        local mousePosition = UI.pointerPosition()
        local rulerPosition, rulerSize = UI.ruler.AbsolutePosition, UI.ruler.AbsoluteSize
        local overRuler = mousePosition.X >= rulerPosition.X and mousePosition.X <= rulerPosition.X + rulerSize.X and mousePosition.Y >= rulerPosition.Y and mousePosition.Y <= rulerPosition.Y + rulerSize.Y
        local trackPosition, trackSize = UI.trackArea.AbsolutePosition, UI.trackArea.AbsoluteSize
        local overTracks = mousePosition.X >= trackPosition.X and mousePosition.X <= trackPosition.X + trackSize.X and mousePosition.Y >= trackPosition.Y and mousePosition.Y <= trackPosition.Y + trackSize.Y
        local controlHeld = UserInputService:IsKeyDown(Enum.KeyCode.LeftControl) or UserInputService:IsKeyDown(Enum.KeyCode.RightControl)
        local shiftHeld = UserInputService:IsKeyDown(Enum.KeyCode.LeftShift) or UserInputService:IsKeyDown(Enum.KeyCode.RightShift)
        if (overRuler or overTracks) and (controlHeld or shiftHeld) then
            UI.trackArea.ScrollingEnabled = false
            if controlHeld then zoomTimeline(1.2 ^ input.Position.Z, mousePosition.X) else panTimeline(input.Position.Z) end
            task.defer(function() if UI.trackArea.Parent then UI.trackArea.ScrollingEnabled = true end end)
        end
    elseif input.UserInputType == Enum.UserInputType.MouseMovement then
        if draggingRangeHandle then updateDraggedRangeHandle(UI.pointerPosition().X)
        elseif draggingContactHandle then UI.updateDraggedContactHandle(UI.pointerPosition().X)
        elseif draggingSemanticKey then UI.updateDraggedSemanticKey(UI.pointerPosition().X)
        elseif draggingKey then updateDraggedKey(UI.pointerPosition().X)
        elseif timelineScrubbing then seekTimeline(UI.pointerPosition().X) end
    end
end)
UI.timelineEndConnection = UserInputService.InputEnded:Connect(function(input)
    if input.UserInputType == Enum.UserInputType.MouseButton1 then
        local rangeHandle = draggingRangeHandle
        local rangeSnapLabel = draggingRangeHandleSnapLabel
        draggingRangeHandle = nil
        draggingRangeHandleSnapLabel = nil
        if rangeHandle then
            UI.status.Text = rangeSnapLabel and ("Playback " .. rangeHandle .. " snapped to " .. rangeSnapLabel .. ".") or ("Playback " .. rangeHandle .. " adjusted freely.")
        end
        timelineScrubbing = false
        if draggingContactHandle then
            local moved = draggingContactHandle.moved
            draggingContactHandle = nil
            refreshTimeline()
            if moved then UI.status.Text = "Contact interval retimed. Undo is available; save a revision to preserve it." end
        end
        if draggingKey then
            local drag = draggingKey
            draggingKey = nil
            refreshTimeline()
            updateHistoryButtons()
            if drag.error and not drag.moved then
                UI.status.Text = drag.error
            elseif drag.moved then
                if drag.selectedCount > 1 then
                    UI.status.Text = string.format("Retimed %d selected keyframes across %d tracks%s. Undo is available; save a revision to preserve the edit.",
                        drag.selectedCount, drag.affectedTrackCount or 0, drag.clamped and " · stopped before neighboring keys" or drag.snapLabel and (" · snapped to " .. drag.snapLabel) or "")
                else
                    UI.status.Text = drag.clamped and "Key timing stopped before a neighboring key. Undo is available; save a revision to preserve the edit."
                        or drag.snapLabel and ("Key snapped to " .. drag.snapLabel .. ". Undo is available; save a revision to preserve the edit.")
                        or "Key timing adjusted freely. Undo is available; save a revision to preserve the edit."
                end
            end
        end
        if draggingSemanticKey then
            local drag = draggingSemanticKey
            draggingSemanticKey = nil
            refreshTimeline()
            if drag.moved then
                UI.status.Text = drag.snapLabel and ("Timeline " .. drag.kind .. " snapped to " .. drag.snapLabel .. ". Undo is available; save a revision to preserve it.") or "Timeline event retimed. Undo is available; save a revision to preserve it."
            end
        end
    end
end)
local trackScrollSync = false
UI.trackNameScrollConnection = UI.trackNames:GetPropertyChangedSignal("CanvasPosition"):Connect(function()
    if trackScrollSync then return end
    trackScrollSync = true
    UI.trackArea.CanvasPosition = UI.trackNames.CanvasPosition
    trackScrollSync = false
end)
UI.trackAreaScrollConnection = UI.trackArea:GetPropertyChangedSignal("CanvasPosition"):Connect(function()
    if trackScrollSync then return end
    trackScrollSync = true
    UI.trackNames.CanvasPosition = UI.trackArea.CanvasPosition
    trackScrollSync = false
end)

local function recordingCommand(name, callback)
    local id = ChangeHistoryService:TryBeginRecording("MotionTools", name)
    assert(id, "Studio cannot begin an undo recording. Finish the current edit first.")
    local ok, result = pcall(callback)
    ChangeHistoryService:FinishRecording(id, ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel)
    assert(ok, result)
    return result
end

UI.orbiting = false
UI.orbitStartConnection = UI.viewport.InputBegan:Connect(function(input)
    if input.UserInputType == Enum.UserInputType.MouseButton2
        and UI.viewportPointAvailable(UI.pointerPosition()) then
        UI.orbiting = true
    end
end)
UI.orbitConnection = UI.viewport.InputChanged:Connect(function(input)
    if input.UserInputType == Enum.UserInputType.MouseWheel and viewportClone
        and UI.viewportPointAvailable(UI.pointerPosition()) then
        orbitDistance = math.clamp(orbitDistance - input.Position.Z * math.max(orbitDistance * 0.12, 1), minimumZoom, maximumZoom)
        local cameraOffset = CFrame.fromOrientation(orbitPitch, orbitYaw, 0).LookVector * -orbitDistance
        camera.CFrame = CFrame.lookAt(orbitFocus + cameraOffset, orbitFocus)
        updateViewportHud()
    elseif input.UserInputType == Enum.UserInputType.MouseMovement and UI.orbiting and viewportClone then
        local delta = input.Delta
        orbitYaw -= delta.X * 0.008
        orbitPitch = math.clamp(orbitPitch + delta.Y * 0.008, math.rad(-75), math.rad(75))
        local cameraOffset = CFrame.fromOrientation(orbitPitch, orbitYaw, 0).LookVector * -orbitDistance
        camera.CFrame = CFrame.lookAt(orbitFocus + cameraOffset, orbitFocus)
        updateViewportHud()
    end
end)
UI.orbitEndConnection = UI.viewport.InputEnded:Connect(function(input)
    if input.UserInputType == Enum.UserInputType.MouseButton2 then UI.orbiting = false end
end)
UI.orbitLeaveConnection = UI.viewport.MouseLeave:Connect(function() UI.orbiting = false end)
UI.orbitVisibilityConnection = widget:GetPropertyChangedSignal("Enabled"):Connect(function()
    if not widget.Enabled then UI.orbiting = false; gizmoDrag = nil end
end)
UI.gizmoInputChangedConnection = UserInputService.InputChanged:Connect(function(input)
    if not gizmoDrag or input.UserInputType ~= Enum.UserInputType.MouseMovement then return end
    local drag = gizmoDrag
    if drag.mode == "IK" then
        if drag.failed then return end
        local pointer = UI.pointerPosition() - UI.viewport.AbsolutePosition
        local pointerDelta = pointer - drag.startPointer
        if pointerDelta.Magnitude < 1 then return end
        if not drag.undoPushed then
            pushUndoSnapshot()
            drag.undoPushed = true
        end
        local depth = (drag.startGoal - camera.CFrame.Position).Magnitude
        local viewportHeight = math.max(UI.viewport.AbsoluteSize.Y, 1)
        local studsPerPixel = 2 * depth * math.tan(math.rad(camera.FieldOfView) / 2) / viewportHeight
        local goal = drag.startGoal + camera.CFrame.RightVector * (pointerDelta.X * studsPerPixel) - camera.CFrame.UpVector * (pointerDelta.Y * studsPerPixel)
        currentRecipe = cloneRecipe(drag.originalRecipe)
        local ok, residual = pcall(function() return applyIKGoal(drag.effectorSlot, drag.solveTime, goal) end)
        if not ok then
            drag.failed = true
            currentRecipe = cloneRecipe(drag.originalRecipe)
            ikGoal = drag.startGoal
            showPose(drag.solveTime)
            UI.status.Text = "IK pose was not applied: " .. tostring(residual)
            return
        end
        drag.changed = true
        drag.lastResidual = residual
        ikGoal = goal
        drag.lastGoal = goal
        for index, track in editableTracks() do
            if track.joint == drag.selectedJoint then
                for keyIndex, key in track.keys do
                    if math.abs(key.time - drag.solveTime) <= 0.0001 then selectedKeyTrackIndex, selectedKeyIndex = index, keyIndex; break end
                end
                break
            end
        end
        local selectedTrack = selectedKeyTrackIndex and editableTracks()[selectedKeyTrackIndex]
        local selectedKey = selectedTrack and selectedKeyIndex and selectedTrack.keys[selectedKeyIndex]
        if selectedTrack and selectedKey then
            for axis = 1, 3 do
                positionBoxes[axis].Text = string.format("%.3f", selectedKey.position[axis])
                rotationBoxes[axis].Text = string.format("%.3f", selectedKey.rotation[axis])
            end
        end
        return
    end
    local track = currentRecipe and editableTracks()[drag.trackIndex]
    local key = track and track.keys[drag.keyIndex]
    if not key then gizmoDrag = nil; return end
    local point = UI.pointerPosition() - UI.viewport.AbsolutePosition
    local position, rotation = table.clone(drag.originalPosition), table.clone(drag.originalRotation)
    if drag.mode == "Move" then
        local axisProjection = drag.axisProjection
        if not axisProjection then return end
        local pointerDelta = point - drag.startPointer
        local distance = Manipulator.moveDelta(pointerDelta.X, pointerDelta.Y, axisProjection.direction.X, axisProjection.direction.Y, axisProjection.studsPerPixel)
        position[drag.axis] = math.clamp(position[drag.axis] + distance, -100, 100)
        drag.changed = drag.changed or math.abs(distance) > 0.0005
    else
        local deltaDegrees = Manipulator.rotationDelta(drag.startPointer.X, drag.startPointer.Y, point.X, point.Y, drag.pivot.X, drag.pivot.Y)
        rotation[drag.axis] = math.clamp(rotation[drag.axis] + deltaDegrees, -720, 720)
        drag.changed = drag.changed or math.abs(deltaDegrees) > 0.1
    end
    if not drag.changed then return end
    if not drag.undoPushed then
        pushUndoSnapshot()
        drag.undoPushed = true
    end
    key.position, key.rotation = position, rotation
    if currentRecipe.loop and (drag.keyIndex == 1 or drag.keyIndex == #track.keys) then
        local matching = drag.keyIndex == 1 and track.keys[#track.keys] or track.keys[1]
        matching.position, matching.rotation = table.clone(position), table.clone(rotation)
    end
    UI.setRecipeDirty(true)
    for axis = 1, 3 do
        positionBoxes[axis].Text = string.format("%.3f", key.position[axis])
        rotationBoxes[axis].Text = string.format("%.3f", key.rotation[axis])
    end
    showPose(key.time)
end)
UI.gizmoInputEndedConnection = UserInputService.InputEnded:Connect(function(input)
    if input.UserInputType ~= Enum.UserInputType.MouseButton1 or not gizmoDrag then return end
    local drag = gizmoDrag
    gizmoDrag = nil
    if drag.changed then
        refreshTimeline()
        if drag.mode == "IK" then
            local info = ikEffectorInfo[drag.effectorSlot]
            local selectedTrackIndex, selectedKeyIndexForIK
            for index, track in editableTracks() do
                if info and track.joint == info.endpoint.name then
                    selectedTrackIndex = index
                    for keyIndex, key in track.keys do
                        if math.abs(key.time - drag.solveTime) <= 0.0001 then selectedKeyIndexForIK = keyIndex; break end
                    end
                    break
                end
            end
            if selectedTrackIndex and selectedKeyIndexForIK then selectKey(selectedTrackIndex, selectedKeyIndexForIK, true) end
            ikGoal = drag.lastGoal
            UI.status.Text = string.format("IK posed %s · residual %.3f studs. Undo is available; save a revision to preserve it.", info and info.endpoint.name or "limb", drag.lastResidual or 0)
        else
            selectKey(drag.trackIndex, drag.keyIndex, true)
            UI.status.Text = "Viewport pose edited locally. Undo is available; save a revision to preserve it."
        end
    end
end)
UI.axisWidgetConnection = RunService.RenderStepped:Connect(function()
    if not camera or not UI.axisWidget.Parent then return end
    local center = UI.axisWidget.AbsoluteSize / 2
    local radius = 33
    for index, direction in axisDirections do
        local localAxis = camera.CFrame:VectorToObjectSpace(direction.vector)
        local projected = Vector2.new(localAxis.X, -localAxis.Y)
        local length = projected.Magnitude
        if length > 0.001 then projected = projected / length end
        local isFront = localAxis.Z >= 0
        local axisButton = UI.axisButtons[index]
        axisButton.Position = UDim2.fromOffset(center.X + projected.X * radius, center.Y + projected.Y * radius)
        axisButton.BackgroundColor3 = isFront and direction.color or direction.backColor
        axisButton.TextTransparency = isFront and 0 or 0.12
        axisButton.BackgroundTransparency = isFront and 0 or 0.18
        axisButton.ZIndex = isFront and 8 or 6
        for _, child in axisButton:GetChildren() do
            if child.Name == "DirectionSign" then child.ZIndex = axisButton.ZIndex + 1 end
        end
    end
    updateJointManipulator()
end)

button.Click:Connect(function()
    widget.Enabled = not widget.Enabled
    if widget.Enabled then refreshRigList() end
end)
UI.library.MouseEnter:Connect(function()
    UI.libraryHovered = true
    hoverGeneration += 1
    setLibraryExpanded(true)
end)
UI.library.MouseLeave:Connect(function()
    UI.libraryHovered = false
    hoverGeneration += 1
    local generation = hoverGeneration
    task.delay(0.18, function()
        if generation == hoverGeneration and not libraryPinned then setLibraryExpanded(false) end
    end)
end)
UI.pinButton.MouseButton1Click:Connect(function()
    libraryPinned = not libraryPinned
    setLibraryExpanded(libraryPinned or UI.libraryHovered == true)
end)
UI.rigRailButton.MouseButton1Click:Connect(function() setLibraryExpanded(true); UI.rigSearchBox:CaptureFocus() end)
UI.animationRailButton.MouseButton1Click:Connect(function() setLibraryExpanded(true); task.defer(function() UI.dropdown.CanvasPosition = Vector2.zero end) end)
UI.connectButton.MouseButton1Click:Connect(function()
    connected = not connected
    bridgeAvailable = false
    UI.connectionLabel.Text = connected and "Connecting…" or "Disconnected"
    UI.connectionLabel.TextColor3 = connected and COLORS.accent or COLORS.muted
    updateConnectionControls()
    if not connected then Preview.stop(); stopEditorPlayback(); UI.status.Text = "Disconnected"
    else
        refreshRigList()
    end
end)
UI.createRigButton.MouseButton1Click:Connect(function() createRig(Enum.HumanoidRigType.R15) end)
UI.rigOptionsButton.MouseButton1Click:Connect(function() createRig(Enum.HumanoidRigType.R6) end)
UI.rigSearchBox:GetPropertyChangedSignal("Text"):Connect(renderRigList)
refreshRigList()
renderAnimationLibrary = function()
    for _, child in UI.dropdown:GetChildren() do child:Destroy() end
    local byId, hasChild = {}, {}
    for _, asset in availableAnimations do
        byId[asset.id] = asset
        if asset.parentId then hasChild[asset.parentId] = true end
    end
    local query = UI.animationSearchBox.Text:lower():match("^%s*(.-)%s*$")
    local visible, rowIndex = {}, 0
    for _, asset in availableAnimations do
        local latest = not hasChild[asset.id]
        local matchesSearch = query == "" or asset.name:lower():find(query, 1, true) or asset.id:lower():find(query, 1, true)
        if (showAllRevisions or latest) and matchesSearch then table.insert(visible, asset) end
    end
    for _, asset in visible do
        rowIndex += 1
        local depth, parentId, visited = 1, asset.parentId, {}
        while parentId and byId[parentId] and not visited[parentId] do
            visited[parentId] = true
            depth += 1
            parentId = byId[parentId].parentId
        end
        local date = string.sub(asset.createdAt, 1, 10)
        local isSelected = asset.id == selectedAssetId
        local row = Instance.new("TextButton")
        row.Name = "Animation_" .. asset.id
        row.Size = UDim2.new(1, -8, 0, 54)
        row.Position = UDim2.fromOffset(4, (rowIndex - 1) * 60)
        row.BackgroundColor3 = isSelected and COLORS.accentSoft or COLORS.raised
        row.BorderSizePixel = 0
        row.Text = ""
        row.AutoButtonColor = false
        row.Parent = UI.dropdown
        local rowCorner = Instance.new("UICorner")
        rowCorner.CornerRadius = UDim.new(0, 7)
        rowCorner.Parent = row
        local rowStroke = Instance.new("UIStroke")
        rowStroke.Color = isSelected and COLORS.accent or COLORS.border
        rowStroke.Transparency = isSelected and 0.35 or 0.78
        rowStroke.Thickness = 1
        rowStroke.Parent = row
        local nameLabel = text(row, "TextLabel", asset.name, UDim2.fromOffset(12, 5), UDim2.new(1, -22, 0, 22))
        nameLabel.BackgroundTransparency = 1
        nameLabel.TextSize = 13
        nameLabel.Font = FONTS.ui
        nameLabel.TextColor3 = isSelected and COLORS.text or Color3.fromRGB(202, 214, 226)
        nameLabel.TextXAlignment = Enum.TextXAlignment.Left
        nameLabel.TextTruncate = Enum.TextTruncate.AtEnd
        local detailLabel = text(row, "TextLabel", "v" .. tostring(depth) .. "  ·  " .. date .. "  ·  " .. string.sub(asset.id, 1, 6), UDim2.fromOffset(12, 29), UDim2.new(1, -22, 0, 16))
        detailLabel.BackgroundTransparency = 1
        detailLabel.TextSize = 10
        detailLabel.Font = FONTS.data
        detailLabel.TextColor3 = isSelected and COLORS.accent or COLORS.muted
        detailLabel.TextXAlignment = Enum.TextXAlignment.Left
        detailLabel.TextTruncate = Enum.TextTruncate.AtEnd
        if isSelected then
            local marker = Instance.new("Frame")
            marker.Name = "SelectedMarker"
            marker.Size = UDim2.new(0, 3, 1, -14)
            marker.Position = UDim2.new(0, 1, 0, 7)
            marker.BackgroundColor3 = COLORS.accent
            marker.BorderSizePixel = 0
            marker.Parent = row
            local markerCorner = Instance.new("UICorner")
            markerCorner.CornerRadius = UDim.new(1, 0)
            markerCorner.Parent = marker
        end
        setToolTip(row, asset.id .. (asset.parentId and "\nParent: " .. asset.parentId or "\nOriginal library asset"))
        row.MouseEnter:Connect(function()
            TweenService:Create(row, TweenInfo.new(0.12), { BackgroundColor3 = isSelected and COLORS.accentSoft or COLORS.controlHover }):Play()
        end)
        row.MouseLeave:Connect(function()
            local color = isSelected and COLORS.accentSoft or COLORS.raised
            TweenService:Create(row, TweenInfo.new(0.15), { BackgroundColor3 = color }):Play()
        end)
        row.MouseButton1Click:Connect(function()
            local readOk, loaded = pcall(request, "/library/read", { id = asset.id })
            if readOk then setSelectedAnimation(loaded) else UI.status.Text = tostring(loaded) end
        end)
    end
    UI.dropdown.CanvasSize = UDim2.fromOffset(0, rowIndex * 60)
    local filterName = showAllRevisions and "All" or "Latest"
    UI.revisionFilterButton.Text = filterName
    UI.refreshButton.Text = string.format("Refresh library (%d)", #availableAnimations)
    if rowIndex == 0 then
        local message = query == "" and (showAllRevisions and "No saved animations yet." or "No latest clips found.") or "No clips match your search."
        local empty = text(UI.dropdown, "TextLabel", message, UDim2.fromOffset(8, 8), UDim2.new(1, -16, 0, 36))
        empty.BackgroundTransparency = 1
        empty.TextSize = 13
        empty.TextColor3 = COLORS.muted
        empty.TextXAlignment = Enum.TextXAlignment.Left
    end
end

refreshLibrary = function()
    if libraryBusy then return end
    libraryBusy = true
    local ok, err = pcall(function()
        assert(connected, "Connect Motion Tools to browse saved animations.")
        local assets, seen, offset = {}, {}, 0
        repeat
            local page = request("/library/list", { kind = "animation", offset = offset, limit = 100 })
            for _, asset in page.assets do if not seen[asset.id] then table.insert(assets, asset); seen[asset.id] = true end end
            offset = page.nextOffset
        until offset == nil
        if not alive or not connected then return end
        availableAnimations = assets
        renderAnimationLibrary()
        if selectedAssetId then
            local selected
            for _, asset in assets do if asset.id == selectedAssetId then selected = asset; break end end
            if selected and not currentRecipe then UI.selectedLabel.Text = "Choose animation · " .. selected.name end
        end
    end)
    libraryBusy = false
    if not ok then UI.status.Text = "Library unavailable: " .. tostring(err) end
end
UI.refreshButton.MouseButton1Click:Connect(function() task.spawn(refreshLibrary) end)
UI.animationSearchBox:GetPropertyChangedSignal("Text"):Connect(function() if renderAnimationLibrary then renderAnimationLibrary() end end)
UI.revisionFilterButton.MouseButton1Click:Connect(function()
    showAllRevisions = not showAllRevisions
    if renderAnimationLibrary then renderAnimationLibrary() end
end)
UI.scrubber.FocusLost:Connect(function()
    if not currentRecipe then return end
    local time = tonumber(UI.scrubber.Text)
    if not time then UI.scrubber.Text = "0"; time = 0 end
    time = math.clamp(time, 0, currentRecipe.duration)
    updatePlayhead(time)
    stopEditorPlayback()
    showPose(time)
end)

UI.saveButton.MouseButton1Click:Connect(function()
    local valid, issues = validateAnimationDraft()
    if not valid then reportValidationIssues("Studio save blocked", issues); return end
    local ok, err = pcall(function()
        assert(currentRecipe and selectedAssetId, "Load an animation first.")
        assert(not recipeDirty, "Save Revision before saving this edited pose into Studio.")
        assert(not RunService:IsRunning(), "Stop Play/Test mode before saving.")
        local model = previewRigModel
        assert(model and model:IsA("Model") and (model:IsDescendantOf(workspace) or Rig.isManaged(model)), "The rig loaded for this animation is no longer available. Choose it again in the rig library.")
        local recipe = currentRecipe
        local destinationPath = recordingCommand("Motion Tools: " .. recipe.name, function()
            local sequence = Authoring.sequence(model, recipe, {})
            local motionAssetId = selectedAssetId
            if selectedAssetIsEphemeral then motionAssetId = nil end
            sequence:SetAttribute("MotionAssetId", motionAssetId)
            sequence:SetAttribute("MotionAssetFingerprint", selectedAssetFingerprint)
            local destination = Authoring.saveDestination(model)
            sequence.Parent = destination
            return destination:GetFullName()
        end)
        UI.status.Text = "Saved " .. recipe.name .. " to " .. destinationPath .. "."
    end)
    if not ok then UI.status.Text = tostring(err); setToolTip(UI.status, tostring(err)) end
end)

UI.execute = function(command)
    assert(not RunService:IsRunning(), "Stop Play/Test mode before using Motion Tools.")
    local op, payload = command.operation, command.payload
    if op == "stop_preview" then
        stopEditorPlayback()
        return Preview.stop()
    end
    if op == "capture_preflight" then
        local activeRig = Rig.active()
        assert(activeRig and Rig.id(activeRig) == payload.rigId, "Select the requested target rig in the Motion Tools Rig Library first.")
        return ReviewCapture.preflight(activeRig, payload)
    end
    if op == "capture_chunk" then return ReviewCapture.chunk(payload) end
    if op == "ik_constraints_clear_preview" then
        ikCandidatePreview.clear()
        return { cleared = true, visualOnly = true }
    end
    if op == "ik_constraints_visualize" then return ikCandidatePreview.show(payload) end
    local function structurallyEqual(left, right)
        if type(left) ~= type(right) then return false end
        if type(left) ~= "table" then return left == right end
        for key, value in left do if not structurallyEqual(value, right[key]) then return false end end
        for key in right do if left[key] == nil then return false end end
        return true
    end
    if op == "read_editor_draft" then
        local activeRig = Rig.active()
        assert(currentRecipe and selectedAssetId and previewRigModel, "Load an animation and rig in the Motion Tools viewport before reading its draft.")
        assert(activeRig and Rig.id(activeRig) == payload.rigId and Rig.id(previewRigModel) == payload.rigId,
            "The editor draft is not open on the requested active rig.")
        local rigSignature = Rig.signature(activeRig)
        assert(rigSignature == payload.rigSignature and Rig.signature(previewRigModel) == rigSignature,
            "The active rig topology changed after the editor draft was requested. Inspect the rig and read again.")
        return { rigId = payload.rigId, rigSignature = rigSignature, assetId = selectedAssetId,
            ephemeral = selectedAssetIsEphemeral == true, dirty = recipeDirty == true,
            parentAssetId = selectedAssetParentId, sourceRigProfile = selectedSourceRigProfile,
            sourceFingerprint = selectedAssetFingerprint, currentTime = math.clamp(tonumber(UI.scrubber.Text) or 0, 0, currentRecipe.duration),
            recipe = cloneRecipe(currentRecipe) }
    end
    if op == "apply_editor_candidate" then
        local activeRig = Rig.active()
        assert(currentRecipe and selectedAssetId and previewRigModel, "Load an animation and rig in the Motion Tools viewport before applying a candidate.")
        assert(activeRig and Rig.id(activeRig) == payload.rigId and Rig.id(previewRigModel) == payload.rigId,
            "The editor draft is not open on the requested active rig.")
        local rigSignature = Rig.signature(activeRig)
        assert(rigSignature == payload.rigSignature and Rig.signature(previewRigModel) == rigSignature,
            "The active rig topology changed after draft review. Inspect and read the draft again before applying.")
        assert(payload.recipe and payload.recipe.kind == "animation" and payload.candidateFingerprint,
            "A complete fingerprinted animation candidate is required.")
        local disposition = EditorContext.applyDisposition(recipeDirty,
            structurallyEqual(currentRecipe, payload.expectedDraftRecipe), structurallyEqual(currentRecipe, payload.recipe))
        if disposition == "already_applied" then
            return { applied = true, alreadyApplied = true, rigId = payload.rigId, rigSignature = rigSignature,
                baseDraftFingerprint = payload.expectedDraftFingerprint, candidateFingerprint = payload.candidateFingerprint,
                recipeFingerprint = payload.candidateFingerprint, saved = false, exportAuthorized = false,
                next = "The exact requested candidate is already open as the dirty unsaved draft. Do not apply it again; inspect the current viewport and editor draft." }
        end
        assert(disposition == "apply",
            "The editor draft changed after it was read. No candidate was applied; read the latest draft and review it again.")
        local candidateRecipe = cloneRecipe(payload.recipe)
        local previousRecipe = currentRecipe
        currentRecipe = candidateRecipe
        local valid, issues = validateAnimationDraft()
        if not valid then
            currentRecipe = previousRecipe
            error("Candidate failed Motion Tools validation: " .. table.concat(issues, " "))
        end
        currentRecipe = previousRecipe
        local currentTime = math.clamp(tonumber(UI.scrubber.Text) or 0, 0, previousRecipe.duration)
        local previousState = {
            recipe = cloneRecipe(previousRecipe), layerId = activeLayerId,
            trackIndex = selectedKeyTrackIndex, keyIndex = selectedKeyIndex,
            selectedKeyIndices = captureSelectedKeyIndices(), markers = cloneRecipe(reviewMarkers),
            selectedReviewMarker = selectedReviewMarker, selectedEventIndex = selectedEventIndex,
            playbackRangeIn = playbackRangeIn, playbackRangeOut = playbackRangeOut,
            timelineViewStart = timelineViewStart, timelineViewSpan = timelineViewSpan,
            previewLoop = previewLoop, dirty = recipeDirty,
            undo = table.clone(undoStack), redo = table.clone(redoStack),
        }
        local applied, applyError, rolledBack, rollbackError = EditorTransaction.run(function()
            stopEditorPlayback()
            pushUndoSnapshot()
            currentRecipe = candidateRecipe
            activeLayerId = nil
            selectedKeyTrackIndex, selectedKeyIndex = nil, nil
            table.clear(selectedKeys)
            selectedEventIndex = nil
            playbackRangeIn, playbackRangeOut = nil, nil
            timelineViewStart, timelineViewSpan = 0, nil
            previewLoop = currentRecipe.loop
            UI.setRecipeDirty(true)
            updatePlaybackControls()
            updateHistoryButtons()
            refreshLayerPanel()
            refreshCurveGraph()
            refreshTimeline()
            UI.durationLabel.Text = string.format("/ %.2fs", currentRecipe.duration)
            UI.selectedLabel.Text = currentRecipe.name .. "  /  " .. string.sub(selectedAssetId, 1, 8)
                .. (selectedAssetIsEphemeral and "  ·  CANDIDATE" or "")
            local previewTime = math.clamp(currentTime, 0, currentRecipe.duration)
            updatePlayhead(previewTime)
            showPose(previewTime)
        end, function()
            currentRecipe, activeLayerId = previousState.recipe, previousState.layerId
            selectedKeyTrackIndex, selectedKeyIndex = previousState.trackIndex, previousState.keyIndex
            selectedReviewMarker, selectedEventIndex = previousState.selectedReviewMarker, previousState.selectedEventIndex
            playbackRangeIn, playbackRangeOut = previousState.playbackRangeIn, previousState.playbackRangeOut
            timelineViewStart, timelineViewSpan, previewLoop = previousState.timelineViewStart,
                previousState.timelineViewSpan, previousState.previewLoop
            table.clear(reviewMarkers)
            for _, marker in previousState.markers do table.insert(reviewMarkers, marker) end
            table.clear(undoStack)
            for _, entry in previousState.undo do table.insert(undoStack, entry) end
            table.clear(redoStack)
            for _, entry in previousState.redo do table.insert(redoStack, entry) end
            UI.setRecipeDirty(previousState.dirty)
            restoreSelectedKeyIndices(previousState.selectedKeyIndices)
            updatePlaybackControls()
            updateHistoryButtons()
            refreshLayerPanel()
            refreshCurveGraph()
            refreshTimeline()
            local hasSelectedMarker = selectedReviewMarker ~= nil and reviewMarkers[selectedReviewMarker] ~= nil
            local selectedEvent = selectedEventIndex and currentRecipe.markers and currentRecipe.markers[selectedEventIndex]
            UI.reviewMarkerNameBox.Visible = hasSelectedMarker or selectedEvent ~= nil
            UI.reviewMarkerNameBox.Text = selectedEvent and selectedEvent.name
                or hasSelectedMarker and reviewMarkers[selectedReviewMarker].name or ""
            UI.removeMarkerButton.Active = hasSelectedMarker
            UI.removeMarkerButton.TextTransparency = hasSelectedMarker and 0 or 0.5
            UI.removeEventButton.Active = selectedEvent ~= nil
            UI.removeEventButton.TextTransparency = selectedEvent and 0 or 0.5
            UI.durationLabel.Text = string.format("/ %.2fs", currentRecipe.duration)
            UI.selectedLabel.Text = currentRecipe.name .. "  /  " .. string.sub(selectedAssetId, 1, 8)
                .. (selectedAssetIsEphemeral and "  ·  CANDIDATE" or "")
            if selectedKeyTrackIndex and selectedKeyIndex then
                selectKey(selectedKeyTrackIndex, selectedKeyIndex, true, true)
            else
                UI.keyEditor.Visible = false
                local restoreTime = math.clamp(currentTime, 0, currentRecipe.duration)
                updatePlayhead(restoreTime)
                showPose(restoreTime)
            end
        end)
        if not applied then
            if rolledBack then
                error("Candidate apply was rolled back; the previous unsaved draft and undo/redo history were restored. " .. tostring(applyError))
            end
            error("Candidate apply failed and rollback was incomplete; inspect the current draft before any retry. Apply error: "
                .. tostring(applyError) .. " Rollback error: " .. tostring(rollbackError))
        end
        UI.status.Text = "AI candidate applied to the unsaved viewport draft. Undo is available; review before Save Revision."
        return { applied = true, rigId = payload.rigId, rigSignature = rigSignature,
            baseDraftFingerprint = payload.expectedDraftFingerprint, candidateFingerprint = payload.candidateFingerprint,
            recipeFingerprint = payload.candidateFingerprint, saved = false, exportAuthorized = false }
    end
    if op == "open_animation" then
        assert(payload.recipe and payload.recipe.kind == "animation", "Expected a saved animation recipe.")
        assert(Rig.active() and Rig.id(Rig.active()) == payload.rigId, "Choose the target rig in the Motion Tools rig library before opening the animation.")
        local sameDraft = recipeDirty and selectedAssetId == payload.assetId and currentRecipe
            and structurallyEqual(currentRecipe, payload.recipe)
        assert(not recipeDirty or sameDraft,
            "The Motion Tools viewport contains unsaved edits. Read the current editor draft, then ask the user to Save Revision or Revert before opening another animation.")
        setSelectedAnimation({ id = payload.assetId, recipe = payload.recipe }, sameDraft)
        assert(currentRecipe and selectedAssetId == payload.assetId, "Could not open the animation in the plugin viewport.")
        return { opened = true, assetId = payload.assetId, rigId = payload.rigId, viewport = "Motion Tools Animation Studio" }
    end
    if op == "open_candidate" then
        assert(payload.recipe and payload.recipe.kind == "animation", "Expected an unsaved animation candidate.")
        if payload.initialTime ~= nil then
            assert(type(payload.initialTime) == "number" and payload.initialTime == payload.initialTime
                and payload.initialTime >= 0 and payload.initialTime <= payload.recipe.duration,
                "Candidate initial time must be inside the animation duration.")
        end
        local activeRig = Rig.active()
        assert(activeRig and Rig.id(activeRig) == payload.rigId, "Choose the target rig in the Motion Tools rig library before opening the candidate.")
        assert(payload.rigSignature and Rig.signature(activeRig) == payload.rigSignature, "The target rig topology changed after candidate evaluation. Reinspect and reopen the candidate.")
        assert(payload.candidateId and payload.recipeFingerprint, "Candidate identity is missing. Re-run the candidate preview.")
        local sameDraft = recipeDirty and selectedAssetId == payload.candidateId and currentRecipe and structurallyEqual(currentRecipe, payload.recipe)
        assert(not recipeDirty or sameDraft,
            "The Motion Tools viewport contains unsaved edits. Read the current editor draft, then ask the user to Save Revision or Revert before opening another candidate.")
        setSelectedAnimation({ id = payload.candidateId, recipe = payload.recipe, ephemeral = true,
            parentAssetId = payload.parentAssetId, sourceRigProfile = payload.sourceRigProfile, recipeFingerprint = payload.recipeFingerprint }, sameDraft)
        assert(currentRecipe and selectedAssetId == payload.candidateId, "Could not open the unsaved candidate in the Animation Studio viewport.")
        if payload.initialTime ~= nil then
            stopEditorPlayback()
            updatePlayhead(payload.initialTime)
            showPose(payload.initialTime)
        end
        return { opened = true, candidateId = payload.candidateId, recipeFingerprint = payload.recipeFingerprint,
            rigId = payload.rigId, rigSignature = payload.rigSignature, ephemeral = true, viewport = "Motion Tools Animation Studio",
            currentTime = math.clamp(tonumber(UI.scrubber.Text) or 0, 0, currentRecipe.duration),
            next = "Review this exact candidate in the viewport. Save Revision creates a new local asset (optionally as a child of its source); Save to Studio writes the displayed pose to AnimSaves." }
    end
    if op == "ik_pose" then
        assert(payload.recipe and payload.recipe.kind == "animation", "Expected a saved animation recipe for IK posing.")
        local activeRig = Rig.active()
        assert(activeRig and Rig.id(activeRig) == payload.rigId, "Select the requested target rig in the Motion Tools Rig Library first.")
        if recipeDirty then
            assert(selectedAssetId == payload.assetId, "Save or revert the current viewport draft before using IK on another animation.")
            error("The loaded animation has unsaved edits. Save or revert them before asking the AI to apply IK.")
        end
        if selectedAssetId ~= payload.assetId or not currentRecipe then
            setSelectedAnimation({ id = payload.assetId, recipe = payload.recipe })
        end
        assert(currentRecipe and selectedAssetId == payload.assetId, "Could not load the requested animation into the viewport.")
        local activeLayer = selectedAnimationLayer()
        assert(not activeLayer or activeLayer.blendMode == "Override", "IK posing is available on the base animation and Override layers. Switch out of the Additive layer before running IK.")
        assert(payload.time <= currentRecipe.duration, "IK time is outside the animation duration.")
        refreshIKEffectors()
        local info = ikEffectorInfo[payload.limb]
        assert(info, "The requested limb is not present on this rig. Inspect the rig and choose an available hand or foot.")
        showPose(payload.time)
        local endpoint = nodeWorldPosition(info.endpoint)
        assert(endpoint, "The selected IK endpoint has no world position.")
        local goal = endpoint + Vector3.new(payload.offset[1], payload.offset[2], payload.offset[3])
        local poleTarget = payload.poleTarget and Vector3.new(payload.poleTarget[1], payload.poleTarget[2], payload.poleTarget[3]) or nil
        local residual, keysByJoint, poleErrorDegrees, poleUnavailableReason = applyIKGoal(payload.limb, payload.time, goal, nil, nil, poleTarget)
        local endpointTrackIndex, endpointKeyIndex
        for trackIndex, track in editableTracks() do
            if track.joint == info.endpoint.name then
                endpointTrackIndex = trackIndex
                for keyIndex, key in track.keys do
                    if math.abs(key.time - payload.time) <= 0.0001 then endpointKeyIndex = keyIndex; break end
                end
                break
            end
        end
        assert(endpointTrackIndex and endpointKeyIndex, "IK solver did not produce an end-effector key.")
        selectKey(endpointTrackIndex, endpointKeyIndex)
        activeIKEffector = payload.limb
        setGizmoMode("IK")
        ikGoal = goal
        UI.setRecipeDirty(true)
        return { assetId = payload.assetId, parentId = payload.assetId, limb = payload.limb, joint = info.endpoint.name, time = payload.time, offset = payload.offset,
            poleTargetWorldPosition = poleTarget and { poleTarget.X, poleTarget.Y, poleTarget.Z } or nil,
            bendPlane = poleTarget and IKContact.summarizePoleErrors({ { time = payload.time, errorDegrees = poleErrorDegrees, unavailableReason = poleUnavailableReason } }) or nil,
            residual = residual, recipe = cloneRecipe(currentRecipe),
            next = "Save the returned recipe with motion_library_save and parentId set to assetId, then reopen that child with motion_studio_open_animation for review." }
    end
    if op == "ik_contact" then
        assert(payload.recipe and payload.recipe.kind == "animation", "Expected a saved animation recipe for IK contact solving.")
        local activeRig = Rig.active()
        assert(activeRig and Rig.id(activeRig) == payload.rigId, "Select the requested target rig in the Motion Tools Rig Library first.")
        if recipeDirty then
            assert(selectedAssetId == payload.assetId, "Save or revert the current viewport draft before using IK on another animation.")
            error("The loaded animation has unsaved edits. Save or revert them before asking the AI to solve IK contact.")
        end
        if selectedAssetId ~= payload.assetId or not currentRecipe then
            setSelectedAnimation({ id = payload.assetId, recipe = payload.recipe })
        end
        assert(currentRecipe and selectedAssetId == payload.assetId, "Could not load the requested animation into the viewport.")
        assert(payload.startTime >= 0 and payload.endTime > payload.startTime and payload.endTime <= currentRecipe.duration, "IK contact interval must be inside the animation and have positive duration.")
        local activeLayer = selectedAnimationLayer()
        assert(not activeLayer or activeLayer.blendMode == "Override", "IK contact solving is available on the base animation and Override layers, not Additive layers.")
        refreshIKEffectors()
        local info = ikEffectorInfo[payload.limb]
        assert(info and #info.chain > 0, "The requested limb is not present on this rig. Inspect the rig and choose an available hand or foot.")

        local uniqueTimes = IKContact.schedule(payload.startTime, payload.endTime, payload.sampleRateHz, allRecipeTracks(), 128)
        local chainNames = {}
        for _, node in info.chain do table.insert(chainNames, node.name) end
        IKContact.preflight(chainNames, editableTracks(), allRecipeTracks(), uniqueTimes, currentRecipe.duration, 128, 4096)

        showPose(payload.startTime)
        local endpoint = nodeWorldPosition(info.endpoint)
        assert(endpoint, "The selected IK endpoint has no world position.")
        local offset = Vector3.new(payload.offset[1], payload.offset[2], payload.offset[3])
        local targetPath = payload.targetPath
        if targetPath then
            assert(#targetPath >= 2 and #targetPath <= 32, "IK target path needs 2–32 timed world positions.")
            assert(targetPath[1].time <= payload.startTime and targetPath[#targetPath].time >= payload.endTime, "IK target path must cover the full solve interval.")
        end
        local goal = targetPath and (function()
            local point = IKContact.targetAt(targetPath, payload.startTime, payload.targetPathInterpolation)
            return Vector3.new(point[1], point[2], point[3]) + offset
        end)() or endpoint + offset
        local poleTarget = payload.poleTarget and Vector3.new(payload.poleTarget[1], payload.poleTarget[2], payload.poleTarget[3]) or nil
        local originalRecipe = cloneRecipe(currentRecipe)
        local originalDirty = recipeDirty
        local originalLayerId = activeLayerId
        local originalTrackIndex, originalKeyIndex = selectedKeyTrackIndex, selectedKeyIndex
        local originalEffector, originalGoal, originalGizmoMode = activeIKEffector, ikGoal, gizmoMode
        local undoBackup, redoBackup = table.clone(undoStack), table.clone(redoStack)
        local success, result = pcall(function()
            pushUndoSnapshot()
            local residuals, squaredResidualTotal, maximumResidual = {}, 0, 0
            local endpointKeys, finalGoal
            local poleSamples = {}
            for _, time in uniqueTimes do
                local sampleGoal = goal
                if targetPath then
                    local point = IKContact.targetAt(targetPath, time, payload.targetPathInterpolation)
                    sampleGoal = Vector3.new(point[1], point[2], point[3]) + offset
                end
                local residual, keysByJoint, poleErrorDegrees, poleUnavailableReason = applyIKGoal(payload.limb, time, sampleGoal, payload.toleranceStuds, nil, poleTarget)
                assert(residual == residual and math.abs(residual) < math.huge, "IK contact solver could not produce a finite endpoint residual.")
                residuals[#residuals + 1] = { time = time, residual = residual }
                if poleTarget then table.insert(poleSamples, { time = time, errorDegrees = poleErrorDegrees, unavailableReason = poleUnavailableReason }) end
                squaredResidualTotal += residual * residual
                maximumResidual = math.max(maximumResidual, residual)
                endpointKeys = keysByJoint[info.endpoint.name]
                finalGoal = sampleGoal
            end
            assert(endpointKeys, "IK contact solver did not create an end-effector track.")
            activeIKEffector, ikGoal = payload.limb, finalGoal or goal
            setGizmoMode("IK")
            local trackIndex
            for index, track in editableTracks() do if track.joint == info.endpoint.name then trackIndex = index; break end end
            if trackIndex then
                for keyIndex, key in editableTracks()[trackIndex].keys do
                    if math.abs(key.time - payload.endTime) <= 0.0001 then selectKey(trackIndex, keyIndex); break end
                end
            end
            refreshTimeline()
            local meanSquare = squaredResidualTotal / #residuals
            local solve = IKContact.classifyResiduals(residuals, payload.toleranceStuds)
            local bendPlane = poleTarget and IKContact.summarizePoleErrors(poleSamples) or nil
            return {
                assetId = payload.assetId, parentId = payload.assetId, rigId = payload.rigId, limb = payload.limb,
                joint = info.endpoint.name, startTime = payload.startTime, endTime = payload.endTime,
                targetMode = targetPath and "interpolated_world_path" or "fixed_world_position",
                targetWorldPosition = not targetPath and { goal.X, goal.Y, goal.Z } or nil,
                targetWorldPath = targetPath and table.clone(targetPath) or nil,
                targetPathAssetId = payload.targetPathAssetId,
                targetPathInterpolation = payload.targetPathInterpolation or "linear",
                poleTargetWorldPosition = poleTarget and { poleTarget.X, poleTarget.Y, poleTarget.Z } or nil,
                bendPlane = bendPlane,
                offset = payload.offset, sampleRateHz = payload.sampleRateHz, sampleCount = #residuals,
                toleranceStuds = payload.toleranceStuds, solve = solve,
                maxResidual = maximumResidual, rmsResidual = math.sqrt(meanSquare), samples = residuals,
                recipe = cloneRecipe(currentRecipe), next = solve.status == "converged"
                    and "Every sampled endpoint met the requested tolerance. Preview the full animation and inspect deformation before saving this child revision."
                    or "Some sampled endpoints missed the requested tolerance. Inspect solve.unmetSampleTimes, consider a reachable target path, inspect rig axes, and preview carefully before deciding whether to save.",
            }
        end)
        if not success then
            currentRecipe = originalRecipe
            UI.setRecipeDirty(originalDirty)
            activeLayerId = originalLayerId
            selectedKeyTrackIndex, selectedKeyIndex = originalTrackIndex, originalKeyIndex
            activeIKEffector, ikGoal = originalEffector, originalGoal
            undoStack, redoStack = undoBackup, redoBackup
            setGizmoMode(originalGizmoMode)
            updateHistoryButtons()
            refreshLayerPanel()
            refreshTimeline()
            showPose(payload.startTime)
            error(result, 0)
        end
        return result
    end
    if op == "ik_contact_bake_preview" or op == "ik_contact_bake_apply"
        or op == "ik_retarget_contact_bake_preview" or op == "ik_retarget_contact_bake_apply" then
        local previewOnly = op == "ik_contact_bake_preview" or op == "ik_retarget_contact_bake_preview"
        local applyReviewedCandidate = op == "ik_contact_bake_apply" or op == "ik_retarget_contact_bake_apply"
        local candidateId = payload.candidateId
        local viewportAssetId = candidateId or payload.assetId
        if previewOnly or applyReviewedCandidate then ikCandidatePreview.clear() end
        assert(payload.recipe and payload.recipe.kind == "animation", "Expected an animation recipe for contact-bake IK.")
        local activeRig = Rig.active()
        assert(activeRig and Rig.id(activeRig) == payload.rigId, "Select the requested target rig in the Motion Tools Rig Library first.")
        if payload.rigSignature then assert(Rig.signature(activeRig) == payload.rigSignature, "The target rig topology changed after contact-bake preview. Preview the bake again.") end
        if recipeDirty then
            assert(selectedAssetId == viewportAssetId, "Save or revert the current viewport draft before contact baking another animation.")
            error("The loaded animation has unsaved edits. Save or revert them before contact baking.")
        end
        local reloadEphemeralSource = candidateId and (applyReviewedCandidate or selectedAssetId ~= viewportAssetId or not currentRecipe)
        if reloadEphemeralSource then
            assert(payload.parentAssetId and payload.sourceRigProfile and payload.candidateRecipeFingerprint,
                "Retargeted contact-bake candidate lineage is incomplete.")
            setSelectedAnimation({ id = candidateId, recipe = payload.recipe, ephemeral = true, parentAssetId = payload.parentAssetId,
                sourceRigProfile = payload.sourceRigProfile, recipeFingerprint = payload.candidateRecipeFingerprint }, true)
        elseif selectedAssetId ~= viewportAssetId or not currentRecipe then
            setSelectedAnimation({ id = payload.assetId, recipe = payload.recipe, ephemeral = payload.ephemeralRecipe == true,
                sourceRigProfile = payload.sourceRigProfile })
        end
        assert(currentRecipe and selectedAssetId == viewportAssetId, "Could not load the requested animation into the viewport.")
        local activeLayer = selectedAnimationLayer()
        assert(not activeLayer or activeLayer.blendMode == "Override", "Contact baking is available on the base animation and Override layers, not Additive layers.")
        refreshIKEffectors()
        local plan = IKContact.planBake(currentRecipe.contacts or {}, payload.effectors, currentRecipe.duration, payload.sampleRateHz, allRecipeTracks(), 128)
        assert(type(payload.expectedWindows) == "table" and #payload.expectedWindows == #plan.windows, "Contact-bake windows changed after server preflight. Preview the current animation again.")
        for index, window in plan.windows do
            local expected = payload.expectedWindows[index]
            assert(expected and expected.contactIndex == window.index and expected.effector == window.effector and expected.kind == window.kind
                and math.abs(expected.startTime - window.start) <= 1e-9 and math.abs(expected.endTime - window.endTime) <= 1e-9,
                "Studio contact windows differ from the server preflight. Discard this request and preview the current animation again.")
        end
        assert(type(payload.expectedSamples) == "table" and #payload.expectedSamples == #plan.samples, "Contact-bake schedule changed after server preflight. Preview the current animation again.")
        for index, sample in plan.samples do
            local expected = payload.expectedSamples[index]
            assert(expected and math.abs(expected.time - sample.time) <= 1e-9 and #expected.windowIndices == #sample.windowIndices,
                "Studio contact-bake sample times differ from server preflight. Preview the current animation again.")
            for activeIndex, windowIndex in sample.windowIndices do
                assert(expected.windowIndices[activeIndex] == windowIndex, "Studio active contact group differs from server preflight. Preview the current animation again.")
            end
        end

        local windowByIndex, chainPlans = {}, {}
        for _, window in plan.windows do
            local info = ikEffectorInfo[window.effector]
            assert(info and #info.chain > 0, "The declared contact effector " .. window.effector .. " is not present on the selected rig.")
            local chainNames = {}
            for _, node in info.chain do table.insert(chainNames, node.name) end
            window.info, window.chainNames, window.samples = info, chainNames, {}
            window.sharedJoints, window.couplingMode, window.fixedGoal = {}, "independent_ccd", nil
            windowByIndex[window.index] = window
            table.insert(chainPlans, { limb = window.effector, chainNames = chainNames })
        end
        local jointTimes = {}
        for _, sample in plan.samples do
            for _, windowIndex in sample.windowIndices do
                local window = windowByIndex[windowIndex]
                assert(window, "Contact-bake schedule references an unknown contact window.")
                for _, joint in window.chainNames do
                    jointTimes[joint] = jointTimes[joint] or {}
                    table.insert(jointTimes[joint], sample.time)
                end
            end
        end
        IKContact.preflightSchedule(jointTimes, editableTracks(), allRecipeTracks(), currentRecipe.duration, 128, 4096)

        local originalTime = tonumber(UI.scrubber.Text) or 0
        local originalRecipe = cloneRecipe(currentRecipe)
        local originalDirty, originalLayerId = recipeDirty, activeLayerId
        local originalTrackIndex, originalKeyIndex = selectedKeyTrackIndex, selectedKeyIndex
        local originalEffector, originalGoal, originalGizmoMode = activeIKEffector, ikGoal, gizmoMode
        local undoBackup, redoBackup = table.clone(undoStack), table.clone(redoStack)
        local success, result = pcall(function()
            if not previewOnly then pushUndoSnapshot() end
            local finalEffector, finalGoal, finalTime
            IKContact.solveBake(plan, windowByIndex, {
                preparePose = function(time) showPose(time) end,
                captureAnchor = function(window)
                    local endpoint = nodeWorldPosition(window.info.endpoint)
                    assert(endpoint, "The " .. window.effector .. " contact endpoint has no world position at its anchor time.")
                    return endpoint
                end,
                solve = function(activeWindows, time)
                    local residualByIndex, prepared = {}, table.clone(activeWindows)
                    table.sort(prepared, function(left, right) return left.effector < right.effector end)
                    local sharedJoints, hasShared = {}, false
                    if #prepared > 1 then
                        local activePlans = {}
                        for _, window in prepared do table.insert(activePlans, { limb = window.effector, chainNames = window.chainNames }) end
                        local _, shared = IKContact.planConstraints(activePlans)
                        sharedJoints, hasShared = shared, #shared > 0
                    end
                    if #prepared == 1 then
                        local window = prepared[1]
                        residualByIndex[window.index] = applyIKGoal(window.effector, time, window.fixedGoal, payload.toleranceStuds, 12, nil)
                    else
                        local goals = {}
                        for index, window in prepared do goals[index] = window.fixedGoal end
                        local residuals = IKContact.solveAlternating(prepared, goals, payload.toleranceStuds, hasShared and 6 or 1,
                            function(window, goal)
                                local residual, keysByJoint = applyIKGoal(window.effector, time, goal, hasShared and payload.toleranceStuds * 0.5 or payload.toleranceStuds,
                                    hasShared and 8 or 12, nil)
                                window.lastKeysByJoint = keysByJoint
                                assert(residual == residual and math.abs(residual) < math.huge, window.effector .. " contact IK produced a non-finite residual.")
                            end,
                            function(window, goal)
                                local endpoint = nodeWorldPosition(window.info.endpoint)
                                assert(endpoint, "The " .. window.effector .. " endpoint has no position after solving.")
                                return (endpoint - goal).Magnitude
                            end)
                        for index, window in prepared do residualByIndex[window.index] = residuals[index] end
                        for _, joint in sharedJoints do
                            for _, window in prepared do
                                for _, name in window.chainNames do
                                    if name == joint then window.sharedJoints[joint] = true end
                                end
                            end
                        end
                    end
                    for _, window in prepared do
                        if hasShared then window.couplingMode = "shared_joint_alternating_ccd" end
                        finalEffector, finalGoal, finalTime = window.effector, window.fixedGoal, time
                    end
                    return residualByIndex
                end,
            })

            local solveResults = {}
            for _, window in plan.windows do
                assert(#window.samples > 0, "A selected contact window received no IK samples.")
                local solve = IKContact.classifyResiduals(window.samples, payload.toleranceStuds)
                local shared = {}
                for joint in window.sharedJoints do table.insert(shared, joint) end
                table.sort(shared)
                table.insert(solveResults, {
                    contactIndex = window.index, effector = window.effector, kind = window.kind,
                    startTime = window.start, endTime = window.endTime,
                    targetWorldPosition = { window.fixedGoal.X, window.fixedGoal.Y, window.fixedGoal.Z },
                    couplingMode = window.couplingMode, sharedJoints = shared,
                    solve = solve, samples = window.samples,
                })
            end
            local candidateRecipe = cloneRecipe(currentRecipe)
            if applyReviewedCandidate then
                assert(type(payload.expectedCandidateRecipe) == "table" and structurallyEqual(candidateRecipe, payload.expectedCandidateRecipe),
                    "The recomputed contact-bake recipe differs from the exact reviewed preview. No changes were applied; preview again.")
                assert(type(payload.expectedCandidateSolves) == "table" and structurallyEqual(solveResults, payload.expectedCandidateSolves),
                    "The recomputed contact-bake residual evidence differs from the reviewed preview. No changes were applied; preview again.")
            end
            if previewOnly then
                return { assetId = payload.assetId, candidateId = candidateId, parentId = payload.parentAssetId or payload.assetId, rigId = payload.rigId,
                    sampleCount = #plan.samples, windows = solveResults, recipe = candidateRecipe, previewOnly = true,
                    next = candidateId and "The exact retargeted contact-bake candidate is now loaded in the Animation Studio viewport for inspection. It is ephemeral and unsaved; apply only with its returned fingerprint."
                        or "No viewport edits or undo entries were retained. Inspect every contact residual and the full candidate, then apply only with its returned fingerprint." }
            end
            activeIKEffector, ikGoal = finalEffector, finalGoal
            if finalEffector and finalTime then
                setGizmoMode("IK")
                local info = ikEffectorInfo[finalEffector]
                local trackIndex
                for index, track in editableTracks() do if track.joint == info.endpoint.name then trackIndex = index; break end end
                if trackIndex then
                    for keyIndex, key in editableTracks()[trackIndex].keys do
                        if math.abs(key.time - finalTime) <= 0.0001 then selectKey(trackIndex, keyIndex); break end
                    end
                end
            end
            refreshTimeline()
            return { assetId = payload.assetId, candidateId = candidateId, parentId = payload.parentAssetId or payload.assetId, rigId = payload.rigId,
                sampleCount = #plan.samples, windows = solveResults, recipe = candidateRecipe,
                next = "The contact bake was applied to the unsaved viewport draft only. Inspect the full clip and save a child library revision only after review." }
        end)
        if not success then
            currentRecipe = originalRecipe
            UI.setRecipeDirty(originalDirty)
            activeLayerId = originalLayerId
            selectedKeyTrackIndex, selectedKeyIndex = originalTrackIndex, originalKeyIndex
            activeIKEffector, ikGoal = originalEffector, originalGoal
            undoStack, redoStack = undoBackup, redoBackup
            setGizmoMode(originalGizmoMode)
            updateHistoryButtons()
            refreshLayerPanel()
            refreshTimeline()
            showPose(originalTime)
            error(result, 0)
        end
        if previewOnly then
            if candidateId then
                local opened, openError = pcall(function()
                    setSelectedAnimation({ id = candidateId, recipe = result.recipe, ephemeral = true,
                        parentAssetId = payload.parentAssetId, sourceRigProfile = payload.sourceRigProfile }, true)
                    ephemeralBaseRecipe = cloneRecipe(payload.recipe)
                    selectedAssetFingerprint = nil
                    UI.setRecipeDirty(false)
                    activeIKEffector, ikGoal = nil, nil
                    table.clear(undoStack)
                    table.clear(redoStack)
                    updateHistoryButtons()
                    UI.status.Text = "Retarget + contact-bake candidate loaded for review. Apply the exact MCP candidate to create a saveable draft."
                end)
                if not opened then error("Could not load the retarget/contact-bake preview into the Animation Studio viewport: " .. tostring(openError), 0) end
            else
                currentRecipe = originalRecipe
                UI.setRecipeDirty(originalDirty)
                activeLayerId = originalLayerId
                selectedKeyTrackIndex, selectedKeyIndex = originalTrackIndex, originalKeyIndex
                activeIKEffector, ikGoal = originalEffector, originalGoal
                undoStack, redoStack = undoBackup, redoBackup
                setGizmoMode(originalGizmoMode)
                updateHistoryButtons()
                refreshLayerPanel()
                refreshTimeline()
                showPose(originalTime)
            end
        end
        return result
    end
    if op == "ik_constraints" or op == "ik_constraints_preview" or op == "ik_constraints_apply" then
        local previewOnly = op == "ik_constraints_preview"
        local applyReviewedCandidate = op == "ik_constraints_apply"
        if previewOnly or applyReviewedCandidate then ikCandidatePreview.clear() end
        assert(payload.recipe and payload.recipe.kind == "animation", "Expected an animation recipe for coordinated IK.")
        local activeRig = Rig.active()
        assert(activeRig and Rig.id(activeRig) == payload.rigId, "Select the requested target rig in the Motion Tools Rig Library first.")
        if payload.rigSignature then assert(Rig.signature(activeRig) == payload.rigSignature, "The target rig topology changed after coordinated IK preview. Preview the solve again.") end
        if recipeDirty then
            assert(selectedAssetId == payload.assetId, "Save or revert the current viewport draft before using coordinated IK on another animation.")
            error("The loaded animation has unsaved edits. Save or revert them before asking the AI to solve coordinated IK.")
        end
        if selectedAssetId ~= payload.assetId or not currentRecipe then
            setSelectedAnimation({ id = payload.assetId, recipe = payload.recipe,
                ephemeral = payload.ephemeralRecipe == true, parentAssetId = payload.parentAssetId,
                sourceRigProfile = payload.sourceRigProfile, recipeFingerprint = payload.recipeFingerprint })
        end
        assert(currentRecipe and selectedAssetId == payload.assetId, "Could not load the requested animation into the viewport.")
        assert(payload.startTime >= 0 and payload.endTime > payload.startTime and payload.endTime <= currentRecipe.duration, "Coordinated IK interval must be inside the animation.")
        assert(type(payload.orientationToleranceDegrees) == "number" and payload.orientationToleranceDegrees == payload.orientationToleranceDegrees
            and payload.orientationToleranceDegrees >= 0 and payload.orientationToleranceDegrees <= 180,
            "Orientation tolerance must be finite and between 0 and 180 degrees.")
        local activeLayer = selectedAnimationLayer()
        assert(not activeLayer or activeLayer.blendMode == "Override", "Coordinated IK supports the base animation and Override layers, not Additive layers.")
        assert(type(payload.constraints) == "table" and #payload.constraints >= 1 and #payload.constraints <= 4, "IK needs 1–4 effectors.")
        refreshIKEffectors()

        local prepared, chainPlans = {}, {}
        for _, constraint in payload.constraints do
            local info = ikEffectorInfo[constraint.limb]
            assert(info and #info.chain > 0, "The requested limb " .. tostring(constraint.limb) .. " is not present on this rig.")
            if constraint.targetOrientationDegrees then orientationFrameFromDegrees(constraint.targetOrientationDegrees) end
            if constraint.targetOrientationDegrees and constraint.targetOrientationPath then error("Specify a fixed orientation or an orientation path for " .. constraint.limb .. ", not both.") end
            local chainNames = {}
            for _, node in info.chain do table.insert(chainNames, node.name) end
            table.insert(chainPlans, { limb = constraint.limb, chainNames = chainNames })
            if constraint.targetPath then
                assert(#constraint.targetPath >= 2 and #constraint.targetPath <= 32, constraint.limb .. " target path needs 2–32 samples.")
                assert(constraint.targetPath[1].time <= payload.startTime and constraint.targetPath[#constraint.targetPath].time >= payload.endTime, constraint.limb .. " target path must cover the full interval.")
                IKContact.targetAt(constraint.targetPath, payload.startTime, constraint.targetPathInterpolation)
            end
            if constraint.targetOrientationPath then
                assert(#constraint.targetOrientationPath >= 2 and #constraint.targetOrientationPath <= 32,
                    constraint.limb .. " orientation path needs 2–32 samples.")
                assert(constraint.targetOrientationPath[1].time <= payload.startTime
                    and constraint.targetOrientationPath[#constraint.targetOrientationPath].time >= payload.endTime,
                    constraint.limb .. " orientation path must cover the full interval.")
                IKContact.orientationAt(constraint.targetOrientationPath, payload.startTime, orientationFrameFromDegrees)
            end
            local poleTarget = constraint.poleTarget and Vector3.new(constraint.poleTarget[1], constraint.poleTarget[2], constraint.poleTarget[3]) or nil
            table.insert(prepared, { limb = constraint.limb, info = info, offset = Vector3.new(constraint.offset[1], constraint.offset[2], constraint.offset[3]), targetPath = constraint.targetPath, targetPathAssetId = constraint.targetPathAssetId, targetOrientationDegrees = constraint.targetOrientationDegrees and table.clone(constraint.targetOrientationDegrees) or nil, targetOrientationPath = constraint.targetOrientationPath and table.clone(constraint.targetOrientationPath) or nil, poleTarget = poleTarget, poleSamples = {} })
        end
        table.sort(chainPlans, function(left, right) return left.limb < right.limb end)
        table.sort(prepared, function(left, right) return left.limb < right.limb end)
        local chainNames, sharedJoints = IKContact.planConstraints(chainPlans)
        local hasSharedJoints = #sharedJoints > 0
        local constraintSweepLimit = hasSharedJoints and 6 or 1
        local limbIterationLimit = hasSharedJoints and 8 or 12
        local uniqueTimes = IKContact.schedule(payload.startTime, payload.endTime, payload.sampleRateHz, allRecipeTracks(), 128)
        IKContact.preflight(chainNames, editableTracks(), allRecipeTracks(), uniqueTimes, currentRecipe.duration, 128, 4096)

        local originalTime = tonumber(UI.scrubber.Text) or 0
        local targetsReady, targetError = pcall(function()
            showPose(payload.startTime)
            for _, constraint in prepared do
                local startTarget
                if constraint.targetPath then
                    local point = IKContact.targetAt(constraint.targetPath, payload.startTime, constraint.targetPathInterpolation)
                    startTarget = Vector3.new(point[1], point[2], point[3])
                else
                    startTarget = nodeWorldPosition(constraint.info.endpoint)
                    assert(startTarget, "The " .. constraint.limb .. " endpoint has no world position.")
                end
                constraint.fixedGoal = startTarget + constraint.offset
                constraint.samples = {}
            end
        end)
        if not targetsReady then showPose(originalTime); error(targetError, 0) end

        local originalRecipe = cloneRecipe(currentRecipe)
        local originalDirty, originalLayerId = recipeDirty, activeLayerId
        local originalTrackIndex, originalKeyIndex = selectedKeyTrackIndex, selectedKeyIndex
        local originalEffector, originalGoal, originalGizmoMode = activeIKEffector, ikGoal, gizmoMode
        local undoBackup, redoBackup = table.clone(undoStack), table.clone(redoStack)
        local success, result = pcall(function()
            if not previewOnly then pushUndoSnapshot() end
            for _, time in uniqueTimes do
                local goals = {}
                for constraintIndex, constraint in prepared do
                    local goal = constraint.fixedGoal
                    if constraint.targetPath then
                        local point = IKContact.targetAt(constraint.targetPath, time, constraint.targetPathInterpolation)
                        goal = Vector3.new(point[1], point[2], point[3]) + constraint.offset
                    end
                    goals[constraintIndex] = goal
                    constraint.sampleTargetRotation = constraint.targetOrientationDegrees
                        and orientationFrameFromDegrees(constraint.targetOrientationDegrees)
                        or constraint.targetOrientationPath and IKContact.orientationAt(constraint.targetOrientationPath, time, orientationFrameFromDegrees)
                end
                local finalResiduals = IKContact.solveAlternating(prepared, goals, payload.toleranceStuds, constraintSweepLimit,
                    function(constraint, goal)
                        local residual, keysByJoint = applyIKGoal(constraint.limb, time, goal, hasSharedJoints and payload.toleranceStuds * 0.5 or payload.toleranceStuds, limbIterationLimit, constraint.poleTarget)
                        if constraint.sampleTargetRotation then
                            applyIKEndpointOrientation(constraint.info, keysByJoint, time, constraint.sampleTargetRotation)
                        end
                        constraint.lastKeysByJoint = keysByJoint
                        assert(residual == residual and math.abs(residual) < math.huge, constraint.limb .. " IK solver could not produce a finite residual.")
                    end,
                    function(constraint, goal)
                        local endpoint = nodeWorldPosition(constraint.info.endpoint)
                        assert(endpoint, "The " .. constraint.limb .. " endpoint has no world position after solving.")
                        return (endpoint - goal).Magnitude
                    end)
                for constraintIndex, constraint in prepared do
                    local sample = { time = time, residual = finalResiduals[constraintIndex] }
                    if constraint.sampleTargetRotation then
                        sample.orientationResidualDegrees = orientationResidualDegrees(constraint.info.endpoint, constraint.sampleTargetRotation)
                        assert(sample.orientationResidualDegrees and sample.orientationResidualDegrees == sample.orientationResidualDegrees
                            and math.abs(sample.orientationResidualDegrees) < math.huge,
                            constraint.limb .. " IK orientation solve could not produce a finite angular residual.")
                        sample.orientationWithinTolerance = sample.orientationResidualDegrees <= payload.orientationToleranceDegrees
                    end
                    table.insert(constraint.samples, sample)
                    if constraint.poleTarget then
                        local poleErrorDegrees, poleUnavailableReason = IKSolver.poleErrorAtPose(constraint.info, constraint.lastKeysByJoint, constraint.poleTarget)
                        table.insert(constraint.poleSamples, { time = time, errorDegrees = poleErrorDegrees, unavailableReason = poleUnavailableReason })
                    end
                end
            end

            local solves = {}
            for _, constraint in prepared do
                local solve = IKContact.classifyResiduals(constraint.samples, payload.toleranceStuds)
                local bendPlane = constraint.poleTarget and IKContact.summarizePoleErrors(constraint.poleSamples) or nil
                local orientationEvidence
                if constraint.targetOrientationDegrees or constraint.targetOrientationPath then
                    local squaredTotal, maximum, maximumTime, samplesWithinTolerance, unmetSampleTimes = 0, -1, nil, 0, {}
                    for _, sample in constraint.samples do
                        local errorDegrees = sample.orientationResidualDegrees
                        assert(errorDegrees, "An orientation-targeted IK sample is missing its angular residual.")
                        squaredTotal += errorDegrees * errorDegrees
                        if errorDegrees > maximum then maximum, maximumTime = errorDegrees, sample.time end
                        if sample.orientationWithinTolerance then samplesWithinTolerance += 1 else table.insert(unmetSampleTimes, sample.time) end
                    end
                    local ratio = samplesWithinTolerance / #constraint.samples
                    orientationEvidence = { status = samplesWithinTolerance == #constraint.samples and "converged" or ratio >= 0.5 and "partial" or "unmet",
                        toleranceDegrees = payload.orientationToleranceDegrees, sampleCount = #constraint.samples,
                        samplesWithinTolerance = samplesWithinTolerance, withinToleranceRatio = ratio, unmetSampleTimes = unmetSampleTimes,
                        maximumErrorDegrees = maximum,
                        rmsErrorDegrees = math.sqrt(squaredTotal / #constraint.samples), maximumErrorTime = maximumTime,
                        limitation = "Status classifies sampled angular residuals against the caller-supplied mechanical tolerance only. It does not validate hand shape, prop alignment, anatomy, contact, or visual quality." }
                end
                table.insert(solves, {
                    limb = constraint.limb, joint = constraint.info.endpoint.name,
                    targetMode = constraint.targetPath and "interpolated_world_path" or "fixed_world_position",
                    targetWorldPosition = not constraint.targetPath and { constraint.fixedGoal.X, constraint.fixedGoal.Y, constraint.fixedGoal.Z } or nil,
                    targetWorldPath = constraint.targetPath and table.clone(constraint.targetPath) or nil,
                    targetOrientationDegrees = constraint.targetOrientationDegrees and table.clone(constraint.targetOrientationDegrees) or nil,
                    targetOrientationPath = constraint.targetOrientationPath and table.clone(constraint.targetOrientationPath) or nil,
                    orientationEvidence = orientationEvidence,
                    targetPathAssetId = constraint.targetPathAssetId,
                    targetPathInterpolation = constraint.targetPathInterpolation or "linear",
                    poleTargetWorldPosition = constraint.poleTarget and { constraint.poleTarget.X, constraint.poleTarget.Y, constraint.poleTarget.Z } or nil,
                    bendPlane = bendPlane,
                    couplingMode = hasSharedJoints and "shared_joint_alternating_ccd" or "independent_ccd",
                    sharedJoints = table.clone(sharedJoints),
                    offset = { constraint.offset.X, constraint.offset.Y, constraint.offset.Z }, solve = solve, samples = constraint.samples,
                })
            end
            local candidateRecipe = cloneRecipe(currentRecipe)
            if applyReviewedCandidate then
                assert(type(payload.expectedCandidateRecipe) == "table" and structurallyEqual(candidateRecipe, payload.expectedCandidateRecipe), "The recomputed coordinated IK recipe differs from the exact reviewed preview. No changes were applied; preview again.")
                assert(type(payload.expectedCandidateSolves) == "table" and structurallyEqual(solves, payload.expectedCandidateSolves), "The coordinated IK residual evidence differs from the reviewed preview. No changes were applied; preview again.")
            end
            if previewOnly then
                return {
                    assetId = payload.assetId, parentId = payload.assetId, rigId = payload.rigId,
                    startTime = payload.startTime, endTime = payload.endTime, sampleRateHz = payload.sampleRateHz,
                    toleranceStuds = payload.toleranceStuds, sampleCount = #uniqueTimes, solves = solves,
                    recipe = candidateRecipe, previewOnly = true,
                    next = "No viewport recipe edits or undo entries were retained. Inspect the candidate and every residual, then apply only with its returned candidateFingerprint.",
                }
            end
            local finalConstraint = prepared[#prepared]
            activeIKEffector = finalConstraint.limb
            local finalGoal = finalConstraint.fixedGoal
            if finalConstraint.targetPath then
                local point = IKContact.targetAt(finalConstraint.targetPath, payload.endTime, finalConstraint.targetPathInterpolation)
                finalGoal = Vector3.new(point[1], point[2], point[3]) + finalConstraint.offset
            end
            ikGoal = finalGoal
            setGizmoMode("IK")
            local endpointTrackIndex
            for index, track in editableTracks() do if track.joint == finalConstraint.info.endpoint.name then endpointTrackIndex = index; break end end
            if endpointTrackIndex then
                for keyIndex, key in editableTracks()[endpointTrackIndex].keys do
                    if math.abs(key.time - payload.endTime) <= 0.0001 then selectKey(endpointTrackIndex, keyIndex); break end
                end
            end
            refreshTimeline()
            return {
                assetId = payload.assetId, parentId = payload.assetId, rigId = payload.rigId,
                startTime = payload.startTime, endTime = payload.endTime, sampleRateHz = payload.sampleRateHz,
                toleranceStuds = payload.toleranceStuds, sampleCount = #uniqueTimes, solves = solves,
                recipe = candidateRecipe,
                next = "Inspect every effector's solve.status and residuals, then preview the combined recipe. Save only the reviewed child revision.",
            }
        end)
        if not success then
            currentRecipe = originalRecipe
            UI.setRecipeDirty(originalDirty)
            activeLayerId = originalLayerId
            selectedKeyTrackIndex, selectedKeyIndex = originalTrackIndex, originalKeyIndex
            activeIKEffector, ikGoal = originalEffector, originalGoal
            undoStack, redoStack = undoBackup, redoBackup
            setGizmoMode(originalGizmoMode)
            updateHistoryButtons()
            refreshLayerPanel()
            refreshTimeline()
            showPose(originalTime)
            error(result, 0)
        end
        if previewOnly then
            currentRecipe = originalRecipe
            UI.setRecipeDirty(originalDirty)
            activeLayerId = originalLayerId
            selectedKeyTrackIndex, selectedKeyIndex = originalTrackIndex, originalKeyIndex
            activeIKEffector, ikGoal = originalEffector, originalGoal
            undoStack, redoStack = undoBackup, redoBackup
            setGizmoMode(originalGizmoMode)
            updateHistoryButtons()
            refreshLayerPanel()
            refreshTimeline()
            showPose(originalTime)
        end
        return result
    end
    local model = Rig.resolve(payload.rigId)
    if op == "sample_animation" then return MotionInspection.sample(model, payload, Rig, Authoring, Preview) end
    if op == "sample_animation_graph_blend" then return GraphMotionInspection.sample(model, payload, Authoring, Rig, Preview, CurveAnimationAuthoring) end
    if op == "sample_animation_graph_fade" then return GraphMotionInspection.captureFade(model, payload, Authoring, Rig, Preview, CurveAnimationAuthoring) end
    if op == "find_animation_export" then
        assert(Rig.id(model) == payload.rigId, "The reconciliation target changed. Select the intended rig and retry.")
        assert(Rig.signature(model) == payload.rigSignature, "The rig topology changed. Inspect the intended rig before reconciling the save.")
        local reference = model:FindFirstChild("AnimSaves")
        local destination
        if reference and reference:IsA("Folder") then destination = reference
        elseif reference and reference:IsA("ObjectValue") and reference.Value and reference.Value:IsA("Folder") then destination = reference.Value end
        if not destination then
            return { found = false, status = "not_found", assetId = payload.assetId, assetFingerprint = payload.assetFingerprint,
                preflightFingerprint = payload.preflightFingerprint, rigId = payload.rigId, rigSignature = payload.rigSignature,
                matches = {}, note = "This rig has no linked AnimSaves folder. No objects were created or modified." }
        end
        local reconciliation = Authoring.reconcileExports(destination:GetChildren(), { assetId = payload.assetId,
            assetFingerprint = payload.assetFingerprint, rigSignature = payload.rigSignature, preflightFingerprint = payload.preflightFingerprint })
        if reconciliation.status == "duplicate_identity" then
            return { found = false, status = "duplicate_identity", assetId = payload.assetId, assetFingerprint = payload.assetFingerprint,
                preflightFingerprint = payload.preflightFingerprint, rigId = payload.rigId, rigSignature = payload.rigSignature,
                matches = reconciliation.matches, totalMatchCount = reconciliation.totalMatchCount, matchesTruncated = reconciliation.matchesTruncated,
                note = "Multiple sequences share this export identity. Nothing was changed; inspect AnimSaves and resolve the duplicate explicitly." }
        end
        if reconciliation.status == "identity_conflict" then
            return { found = false, status = "identity_conflict", assetId = payload.assetId, assetFingerprint = payload.assetFingerprint,
                preflightFingerprint = payload.preflightFingerprint, rigId = payload.rigId, rigSignature = payload.rigSignature,
                matches = reconciliation.matches, totalMatchCount = reconciliation.totalMatchCount, matchesTruncated = reconciliation.matchesTruncated,
                note = "The matching export fingerprint has conflicting metadata. Nothing was changed; inspect AnimSaves." }
        end
        if reconciliation.status == "related_candidates" then
            return { found = false, status = "related_candidates", assetId = payload.assetId, assetFingerprint = payload.assetFingerprint,
                preflightFingerprint = payload.preflightFingerprint, rigId = payload.rigId, rigSignature = payload.rigSignature,
                matches = reconciliation.matches, totalMatchCount = reconciliation.totalMatchCount, matchesTruncated = reconciliation.matchesTruncated,
                note = "One or more sequences reference this asset but lack the exact export identity. They may be legacy saves or exports from another rig/preflight; inspect them manually and do not retry automatically." }
        end
        return { found = reconciliation.found, status = reconciliation.status, assetId = payload.assetId, assetFingerprint = payload.assetFingerprint,
            preflightFingerprint = payload.preflightFingerprint, rigId = payload.rigId, rigSignature = payload.rigSignature,
            matches = reconciliation.matches, totalMatchCount = reconciliation.totalMatchCount, matchesTruncated = reconciliation.matchesTruncated,
            note = reconciliation.found and "The exact fingerprint-bound KeyframeSequence exists in this rig's AnimSaves folder." or "No matching or related KeyframeSequence exists in this rig's AnimSaves folder. No objects were created or modified." }
    end
    if op == "capture_frame" then return ReviewCapture.frame(model, payload) end
    if op == "capture_editor_draft_views" then
        local activeRig = Rig.active()
        assert(currentRecipe and selectedAssetId == payload.editorAssetId and previewRigModel,
            "The requested editor animation is no longer open. Read the current editor draft again before capturing.")
        assert(activeRig and Rig.id(activeRig) == payload.rigId and Rig.id(previewRigModel) == payload.rigId,
            "The editor draft is not open on the requested active rig.")
        local rigSignature = Rig.signature(activeRig)
        assert(rigSignature == payload.rigSignature and Rig.signature(previewRigModel) == rigSignature,
            "The active rig topology changed after draft review. Inspect and read the draft again before capturing.")
        assert(structurallyEqual(currentRecipe, payload.expectedDraftRecipe),
            "The editor draft changed after it was read. No screenshot was captured; read the latest draft first.")
        assert(payload.expectedDraftFingerprint == payload.assetFingerprint,
            "Editor-draft screenshot fingerprint does not match the inspected recipe.")
        local loadedSourceFingerprint = selectedAssetFingerprint
        if payload.expectedLoadedSourceFingerprint then
            assert(loadedSourceFingerprint == payload.expectedLoadedSourceFingerprint,
                "The loaded animation source changed after the draft was read. Read the current editor draft again before capturing.")
        end
        local function assertDraftUnchanged()
            assert(currentRecipe and selectedAssetId == payload.editorAssetId and previewRigModel
                    and Rig.id(previewRigModel) == payload.rigId and Rig.signature(previewRigModel) == rigSignature
                    and structurallyEqual(currentRecipe, payload.expectedDraftRecipe)
                    and selectedAssetFingerprint == loadedSourceFingerprint,
                "The editor draft changed during capture. Stop and read the latest draft before capturing again.")
        end
        local capturePayload = { sessionId = payload.sessionId, rigId = payload.rigId, rigSignature = rigSignature,
            assetId = payload.assetId, assetFingerprint = payload.assetFingerprint, recipe = cloneRecipe(payload.expectedDraftRecipe),
            jointMap = payload.jointMap, frames = payload.frames, validateCaptureState = assertDraftUnchanged }
        local captured = ReviewCapture.frames(model, capturePayload)
        assert(structurallyEqual(currentRecipe, payload.expectedDraftRecipe),
            "The editor draft changed during capture. Captured images were not returned; read and capture the latest version again.")
        assert(selectedAssetFingerprint == loadedSourceFingerprint,
            "The loaded animation source changed during capture. Captured images were not returned; read the latest draft again.")
        captured.loadedSourceFingerprint = loadedSourceFingerprint
        return captured
    end
    if op == "capture_frames" then return ReviewCapture.frames(model, payload) end
    if op == "capture_candidate_comparison" then return ReviewCapture.compare(model, payload) end
    if op == "inspect" then return Rig.inspect(model) end
    if op == "list_local_animations" then
        assert(Rig.active() and Rig.id(Rig.active()) == payload.rigId, "Select the intended rig in the Motion Tools Rig Library before browsing its local animations.")
        return AnimationImport.listLocal(model)
    end
    if op == "import_animation_batch_preview" then
        assert(Rig.active() and Rig.id(Rig.active()) == payload.rigId, "Select the source animation rig in the Motion Tools Rig Library before importing.")
        assert(not recipeDirty, "Save Revision or Revert the current animation edits before importing animations.")
        local sourceRigProfile = Rig.inspect(model).retargetProfile
        assert(sourceRigProfile, "Could not capture the selected source rig profile; inspect the rig and retry the import.")
        local results = {}
        for index, source in payload.sources do
            local sourcePayload = { rigId = payload.rigId, sourceAssetId = source.sourceAssetId, sequenceName = source.sequenceName,
                sequenceLocator = source.sequenceLocator, name = source.name, jointMap = payload.jointMap,
                allowPartial = payload.allowPartial, sampleRate = payload.sampleRate, loopOverride = payload.loopOverride }
            local ok, recipe, unmapped, sourceType, diagnostics = pcall(function()
                return AnimationImport.load(Rig, model, sourcePayload)
            end)
            if ok then
                local sourceIdentity = source.sourceAssetId and { kind = "asset", assetId = source.sourceAssetId }
                    or { kind = "anim_saves", sequenceName = source.sequenceName, sequenceLocator = source.sequenceLocator }
                table.insert(results, { index = index, status = "converted", source = source, recipe = recipe,
                    sourceRigProfile = sourceRigProfile, sourceIdentity = sourceIdentity, sourceType = sourceType,
                    unmapped = unmapped, diagnostics = diagnostics, saved = false })
            else
                table.insert(results, { index = index, status = "failed", source = source,
                    error = string.sub(tostring(recipe), 1, 4000), saved = false })
            end
        end
        return { rigId = payload.rigId, rigSignature = sourceRigProfile.rigSignature, saved = false,
            results = results, note = "Batch preview only. Each source was converted independently; no Motion Tools library asset or Roblox object was created." }
    end
    if op == "import_animation" then
        assert(Rig.active() and Rig.id(Rig.active()) == payload.rigId, "Select the source animation rig in the Motion Tools Rig Library before importing.")
        assert(not recipeDirty, "Save Revision or Revert the current animation edits before importing another animation.")
        local recipe, unmapped, sourceType, diagnostics = AnimationImport.load(Rig, model, payload)
        local sourceRigProfile = Rig.inspect(model).retargetProfile
        assert(sourceRigProfile, "Could not capture the selected source rig profile; inspect the rig and retry the import.")
        local sourceIdentity = payload.sourceAssetId and { kind = "asset", assetId = payload.sourceAssetId }
            or { kind = "anim_saves", sequenceName = payload.sequenceName, sequenceLocator = payload.sequenceLocator }
        if payload.previewOnly then
            return { previewOnly = true, recipe = recipe, sourceRigProfile = sourceRigProfile, sourceIdentity = sourceIdentity,
                sourceType = sourceType, unmapped = unmapped, diagnostics = diagnostics,
                saved = false, note = "Read-only conversion preview. No Motion Tools asset or Roblox object was created." }
        end
        local asset = request("/library/import-save", { recipe = recipe, sourceRigProfile = sourceRigProfile, sourceIdentity = sourceIdentity })
        refreshLibrary()
        setSelectedAnimation(asset, true)
        assert(currentRecipe and selectedAssetId == asset.id, "Imported animation was saved, but could not be opened in the Animation Studio viewport.")
        return { imported = true, idempotent = true, assetId = asset.id, name = recipe.name, sourceType = sourceType, duration = recipe.duration, trackCount = #recipe.tracks,
            markerCount = #recipe.markers, unmapped = unmapped, diagnostics = diagnostics,
            note = "Imported into the editable Motion Tools library. Review diagnostics for easing approximations or reduced CurveAnimation sampling before editing. This did not publish or overwrite the Roblox source asset." }
    end
    if op == "preview" then
        if payload.rigSignature then
            assert(Rig.signature(model) == payload.rigSignature, "The target rig topology changed after VFX cue-sheet preflight. Validate the cue sheet on the intended rig again.")
        end
        if Rig.isManaged(model) then
            Preview.stop()
            if payload.animation then
                assert(payload.animationId, "A saved animation ID is required for the managed-rig combined preview.")
                setSelectedAnimation({ id = payload.animationId, recipe = payload.animation })
                assert(currentRecipe and selectedAssetId == payload.animationId, "Could not load the animation into the Motion Tools viewport.")
            else
                assert(viewportClone and previewRigModel == model, "Load the selected Motion Tools-managed rig into the Animation Studio viewport before previewing VFX.")
            end
            local effectCues, resolvedEffects = {}, {}
            for _, cue in payload.effects do
                table.insert(effectCues, { time = cue.time, recipe = cue.recipe, partInstance = Rig.part(viewportClone, cue.part) })
                table.insert(resolvedEffects, { part = cue.part, time = cue.time, sourceMarker = cue.sourceMarker })
            end
            if payload.animation then
                UI.scrubber.Text = "0"
                showPose(0)
                playEditorAnimation(effectCues, payload.seconds)
            else
                playEditorEffectsOnly(effectCues, payload.seconds)
            end
            return { previewStarted = true, model = model.Name, viewport = "Motion Tools Animation Studio", effectCount = #effectCues,
                resolvedEffects = resolvedEffects,
                note = "Animation and timed VFX are previewed on the isolated viewport rig; no rig or effect was added to Workspace. ViewportFrame rendering differs from the game camera, so visually verify materials, particles, and beams." }
        end
        return Preview.start(model, payload)
    end
    if op == "validate_vfx_timeline" then
        assert(Rig.id(model) == payload.rigId, "Select the VFX cue sheet's target rig and retry preflight.")
        assert(Rig.signature(model) == payload.rigSignature, "The target rig topology changed. Refresh the rig inspection and preflight again.")
        local clone = Preview.copy(model)
        local ok, result = pcall(function()
            clone.Name = "MotionTools_VfxTimelinePreflight"
            clone.Parent = world
            local _, nodes, tracks = Authoring.tracks(clone, payload.animation, payload.jointMap or {})
            local cueChecks = {}
            for index, cue in payload.effects do
                Authoring.apply(nodes, tracks, cue.time)
                local part = Rig.part(clone, cue.part)
                local attachment = Authoring.effect(part, cue.recipe, false)
                attachment:Destroy()
                table.insert(cueChecks, { index = index, part = cue.part, partClass = part.ClassName, time = cue.time,
                    sourceMarker = cue.sourceMarker, targetFound = true, effectConstructed = true })
            end
            return { valid = true, timelineId = payload.timelineId, timelineFingerprint = payload.timelineFingerprint,
                animationId = payload.animationId, rigId = payload.rigId, rigSignature = payload.rigSignature,
                duration = payload.animation.duration, cues = cueChecks, saved = false,
                note = "Every effect target exists on the exact rig, each VFX recipe constructed on a disposable clone, and the animation evaluated at every resolved cue time. This checks structure and local preview construction, not rendered quality." }
        end)
        clone:Destroy()
        assert(ok, result)
        result.temporaryCloneDestroyed = true
        return result
    end
    if op == "validate_animation_export_batch" then
        return ExportValidation.batch(model, payload, Rig, Authoring)
    end
    if op == "validate_animation_export" then
        assert(Rig.id(model) == payload.rigId, "The validated rig changed. Select the intended rig and preflight again.")
        assert(Rig.signature(model) == payload.rigSignature, "The rig topology changed since inspection. Inspect the rig and preflight again.")
        local sequence
        local ok, result = pcall(function()
            sequence = Authoring.sequence(model, payload.recipe, payload.jointMap or {})
            local counts = ExportValidation.measure(sequence, payload.recipe, payload.jointMap or {})
            return { valid = true, assetId = payload.assetId, assetFingerprint = payload.assetFingerprint, rigId = payload.rigId,
                rigSignature = payload.rigSignature, frameCount = counts.frameCount, poseCount = counts.poseCount, markerCount = counts.markerCount,
                animatedTrackCount = counts.animatedTrackCount, mappedTargetJoints = counts.mappedTargetJoints, format = "KeyframeSequence", saved = false,
                note = "This exact recipe converted successfully on this rig. Counts describe the generated local KeyframeSequence; this does not publish or guarantee visual quality." }
        end)
        if sequence then sequence:Destroy() end
        assert(ok, result)
        return result
    end
    return recordingCommand("Motion Tools: " .. op, function()
        if op == "connect_parts" then return Rig.connect(model, payload) end
        if op == "save_animation" then
            assert(Rig.id(model) == payload.rigId, "The save target changed. Select the intended rig and retry.")
            assert(Rig.signature(model) == payload.rigSignature, "The rig topology changed since export preflight. Preflight again before saving.")
            assert(type(payload.preflightFingerprint) == "string" and #payload.preflightFingerprint == 64, "A successful export preflight is required before saving.")
            local destination = Authoring.saveDestination(model)
            for _, existing in destination:GetChildren() do
                if existing:IsA("KeyframeSequence") and existing:GetAttribute("MotionExportFingerprint") == payload.preflightFingerprint then
                    assert(existing:GetAttribute("MotionAssetId") == payload.assetId
                        and existing:GetAttribute("MotionAssetFingerprint") == payload.assetFingerprint
                        and existing:GetAttribute("MotionRigSignature") == payload.rigSignature,
                        "An existing export identity has conflicting asset or rig metadata. Do not overwrite it; inspect AnimSaves.")
                    return { saved = existing.Name, kind = "KeyframeSequence", assetId = payload.assetId, assetFingerprint = payload.assetFingerprint,
                        rigSignature = payload.rigSignature, preflightFingerprint = payload.preflightFingerprint, alreadySaved = true,
                        note = "This exact preflight export already exists in the rig's AnimSaves location; reused it instead of creating a duplicate." }
                end
            end
            local sequence = Authoring.sequence(model, payload.recipe, payload.jointMap or {})
            sequence:SetAttribute("MotionAssetId", payload.assetId)
            sequence:SetAttribute("MotionAssetFingerprint", payload.assetFingerprint)
            sequence:SetAttribute("MotionRigSignature", payload.rigSignature)
            sequence:SetAttribute("MotionExportFingerprint", payload.preflightFingerprint)
            sequence.Parent = destination
            return { saved = sequence.Name, kind = "KeyframeSequence", assetId = payload.assetId, assetFingerprint = payload.assetFingerprint,
                rigSignature = payload.rigSignature, preflightFingerprint = payload.preflightFingerprint, alreadySaved = false,
                note = "Local editable sequence. Publish using Roblox's Animation Editor when ready." }
        end
        if op == "save_vfx" then
            local attachment = Authoring.effect(Rig.part(model, payload.part), payload.recipe, false)
            attachment:SetAttribute("MotionAssetId", payload.assetId)
            if payload.recipe.column then return { saved = attachment.Name, kind = "Attachment", note = "3D column recipe saved in MotionColumnRecipe. Motion Tools can replay it; gameplay playback requires a separate runtime integration." } end
            return { saved = attachment.Name, kind = "Attachment", note = payload.recipe.beam and "Laser saved disabled. Enable its Beam children for the Duration attribute, then disable them." or "Emitter saved disabled. EmitCount attribute stores its burst count." }
        end
        error("Unsupported operation: " .. tostring(op))
    end)
end

UI.editorViewportSnapshot = function()
    local inspector = "none"
    for _, entry in { { UI.keyEditor, "pose" }, { UI.layerPanel, "layers" }, { UI.curvePanel, "easing" },
        { UI.poseLibraryPanel, "poses" }, { UI.settingsPanel, "settings" } } do
        if entry[1].Visible then inspector = entry[2]; break end
    end
    local duration = currentRecipe and currentRecipe.duration or nil
    local playhead = currentRecipe and tonumber(UI.scrubber.Text) or nil
    local timelineStart, timelineEnd
    if duration and duration > 0 then timelineStart, timelineEnd = timelineViewBounds(duration) end
    local selectedTrack = currentRecipe and selectedKeyTrackIndex and editableTracks()[selectedKeyTrackIndex] or nil
    local selectedKey = selectedTrack and selectedKeyIndex and selectedTrack.keys[selectedKeyIndex] or nil
    return EditorContext.snapshot({
        layout = { version = 1, inspector = inspector, libraryExpanded = libraryExpanded, libraryPinned = libraryPinned,
            timelineHeightPixels = UI.timelineHeight, viewportWidthPixels = UI.viewport.AbsoluteSize.X,
            viewportHeightPixels = UI.viewport.AbsoluteSize.Y },
        viewportOpen = widget.Enabled,
        rigLoaded = previewRigModel ~= nil and viewportClone ~= nil,
        clipLoaded = currentRecipe ~= nil,
        rigId = previewRigModel and Rig.id(previewRigModel) or nil,
        clipId = selectedAssetId,
        clipName = currentRecipe and currentRecipe.name or nil,
        loadedAssetFingerprint = selectedAssetFingerprint,
        activeLayerId = activeLayerId,
        selectedJoint = selectedTrack and selectedTrack.joint or nil,
        selectedKeyTime = selectedKey and selectedKey.time or nil,
        isPlaying = playbackConnection ~= nil,
        isDirty = recipeDirty,
        isEphemeralCandidate = selectedAssetIsEphemeral,
        looping = previewLoop,
        playheadSeconds = playhead,
        durationSeconds = duration,
        playbackSpeed = playbackSpeed,
        timelineStartSeconds = timelineStart,
        timelineEndSeconds = timelineEnd,
        cameraYawDegrees = math.deg(orbitYaw),
        cameraPitchDegrees = math.deg(orbitPitch),
        cameraDistanceStuds = orbitDistance,
        cameraTargetStuds = { x = orbitFocus.X, y = orbitFocus.Y, z = orbitFocus.Z },
        cameraFieldOfView = camera and camera.FieldOfView or nil,
    })
end

task.spawn(function()
    while alive do
        if connected then
            local ok, result = pcall(function()
                local snapshot = Rig.snapshot()
                snapshot.motionToolsBuild = { version = 1, pluginFingerprint = PLUGIN_BUILD_FINGERPRINT }
                snapshot.motionEditor = UI.editorViewportSnapshot()
                return request("/poll", { sessionId = sessionId, snapshot = snapshot })
            end)
            if ok then
                local response = result
                local firstConnection = not bridgeAvailable
                bridgeAvailable = true
                UI.connectionLabel.Text = "●  " .. game.Name
                UI.connectionLabel.TextColor3 = COLORS.accent
                if firstConnection and refreshLibrary then task.spawn(refreshLibrary) end
                local command = response.command
                if command then
                    local success, result = pcall(UI.execute, command)
                    request("/result", { sessionId = sessionId, id = command.id, ok = success, result = success and result or { error = tostring(result) } })
                    UI.status.Text = success and "Completed: " .. command.operation or tostring(result)
                end
            else
                bridgeAvailable = false
                local message = tostring(result)
                if string.find(message, "ConnectFail", 1, true) or string.find(message, "Failed to connect", 1, true) then
                    UI.connectionLabel.Text = "Waiting for Motion Tools server…"
                    UI.connectionLabel.TextColor3 = COLORS.muted
                    UI.status.Text = "Start the local Motion Tools MCP server; Studio will keep retrying automatically."
                else
                    UI.connectionLabel.Text = "Connection needs attention"
                    UI.connectionLabel.TextColor3 = Color3.fromRGB(232, 164, 100)
                    UI.status.Text = message
                end
            end
        end
        task.wait(connected and 1.25 or 1)
    end
end)
plugin.Unloading:Connect(function()
    UI.resizingTimeline = false
    UI.timelineResizeConnection:Disconnect()
    UI.timelineResizeEndConnection:Disconnect()
    UI.editorLayoutConnection:Disconnect()
end)
plugin.Unloading:Connect(function() alive = false; stopEditorPlayback(); UI.shortcutConnection:Disconnect(); UI.viewportSelectConnection:Disconnect(); UI.gizmoInputStartConnection:Disconnect(); UI.gizmoInputChangedConnection:Disconnect(); UI.gizmoInputEndedConnection:Disconnect(); UI.orbitStartConnection:Disconnect(); UI.orbitConnection:Disconnect(); UI.orbitEndConnection:Disconnect(); UI.orbitLeaveConnection:Disconnect(); UI.orbitVisibilityConnection:Disconnect(); UI.axisWidgetConnection:Disconnect(); UI.timelineInputConnection:Disconnect(); UI.timelineEndConnection:Disconnect(); UI.trackNameScrollConnection:Disconnect(); UI.trackAreaScrollConnection:Disconnect(); UI.curveInputChangedConnection:Disconnect(); UI.curveInputEndedConnection:Disconnect(); Preview.stop(); if viewportClone then viewportClone:Destroy() end end)

