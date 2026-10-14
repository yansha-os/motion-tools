-- UI behavior fixture. No Roblox place, API account, or real network is used.
local function event()
    local listeners = {}
    return { Connect = function(_, callback) table.insert(listeners, callback) end,
        Fire = function(_, ...) for _, callback in listeners do callback(...) end end }
end
local instances = {}
local Instance = {}
function Instance.new(class)
    local object = { ClassName = class, children = {}, MouseButton1Click = event(), MouseButton1Down = event(), MouseButton1Up = event(), Click = event(), Activated = event(), InputBegan = event(), InputChanged = event(), InputEnded = event(), MouseEnter = event(), MouseLeave = event(), FocusLost = event(), Changed = event() }
    function object:GetChildren()
        local children = {}
        for _, child in self.children do if child.Parent == self then table.insert(children, child) end end
        return children
    end
    function object:IsA(className)
        if self.ClassName == className then return true end
        local guiObjects = { Frame = true, TextButton = true, TextLabel = true, TextBox = true, ScrollingFrame = true, ViewportFrame = true, ImageButton = true }
        local guiButtons = { TextButton = true, ImageButton = true }
        if className == "GuiObject" then return guiObjects[self.ClassName] == true end
        if className == "GuiButton" then return guiButtons[self.ClassName] == true end
        if className == "TextLabel" then return self.ClassName == "TextButton" or self.ClassName == "TextBox" end
        return false
    end
    function object:GetPropertyChangedSignal(property)
        self.propertySignals = self.propertySignals or {}
        self.propertySignals[property] = self.propertySignals[property] or event()
        return self.propertySignals[property]
    end
    function object:SetAttribute(name, value) self.attributes = self.attributes or {}; self.attributes[name] = value end
    function object:GetAttribute(name) return self.attributes and self.attributes[name] end
    function object:Destroy()
        if self.Parent then
            local index = table.find(self.Parent.children, self)
            if index then table.remove(self.Parent.children, index) end
        end
    end
    setmetatable(object, { __newindex = function(self, name, value)
        rawset(self, name, value)
        if name == "Parent" and value then table.insert(value.children, self) end
    end })
    table.insert(instances, object)
    return object
end
local UDim2 = {
    new = function(sx, ox, sy, oy) return { sx, ox, sy, oy, X = { Scale = sx, Offset = ox }, Y = { Scale = sy, Offset = oy } } end,
    fromOffset = function(x, y) return { x, y, X = { Scale = 0, Offset = x }, Y = { Scale = 0, Offset = y } } end,
    fromScale = function(x, y) return { x, y, X = { Scale = x, Offset = 0 }, Y = { Scale = y, Offset = 0 } } end,
}
local Color3 = { fromRGB = function(...) return {...} end }
local ColorSequence = { new = function(...) return {...} end }
local ColorSequenceKeypoint = { new = function(...) return {...} end }
local NumberSequence = { new = function(...) return {...} end }
local NumberSequenceKeypoint = { new = function(...) return {...} end }
local vector3Meta = {}
local function vector3(x, y, z) return setmetatable({ X = x or 0, Y = y or 0, Z = z or 0 }, vector3Meta) end
vector3Meta.__unm = function(a) return vector3(-a.X, -a.Y, -a.Z) end
vector3Meta.__add = function(a, b) return vector3(a.X + b.X, a.Y + b.Y, a.Z + b.Z) end
vector3Meta.__sub = function(a, b) return vector3(a.X - b.X, a.Y - b.Y, a.Z - b.Z) end
vector3Meta.__mul = function(a, b) if type(a) == "number" then return vector3(a * b.X, a * b.Y, a * b.Z) end return vector3(a.X * b, a.Y * b, a.Z * b) end
local Vector3 = { new = vector3, zero = vector3(0, 0, 0), xAxis = vector3(1, 0, 0), yAxis = vector3(0, 1, 0), zAxis = vector3(0, 0, 1) }
local CFrame = setmetatable({ identity = {} }, { __index = function(_, name) return function(...) return {..., operation = name} end end })
local Enum = {
    InitialDockState = { Right = "Right" },
    Font = { SourceSans = "SourceSans" },
    FinishRecordingOperation = {},
}
setmetatable(Enum, { __index = function(self, name)
    local values = setmetatable({}, { __index = function(_, value) return value end })
    rawset(self, name, values)
    return values
end })
local UDim = { new = function(...) return {...} end }
local Vector2 = { new = function(...) return {...} end }
local DockWidgetPluginGuiInfo = { new = function(...) return {...} end }
local plugin = { Unloading = event(), settings = {} }
local relativePointer = { X = 240, Y = 170 }
function plugin:GetSetting(key) return self.settings[key] end
function plugin:SetSetting(key, value) self.settings[key] = value end
function plugin:CreateToolbar()
    return { CreateButton = function() return Instance.new("ToolbarButton") end }
end
function plugin:CreateDockWidgetPluginGuiAsync()
    local gui = Instance.new("DockWidgetPluginGui")
    function gui:GetRelativeMousePosition() return relativePointer end
    return gui
end
local task = {
    spawn = function(callback) local thread = coroutine.create(callback); assert(coroutine.resume(thread)); return thread end,
    wait = function() coroutine.yield() end,
}
local selection = { { id = "rig-a", name = "First rig" } }
local previews, stops, requests = {}, 0, {}
local changeDuringRead = false
local Rig = { snapshot = function() return { selection = selection } end, resolve = function(id) return { id = id } end, managedRigs = function() return {} end, isManaged = function() return false end }
local Preview = { start = function(model, payload) table.insert(previews, { model = model, payload = payload }); return { previewed = true } end, stop = function() stops += 1 end }
local Authoring, ReviewCapture, Manipulator, IKSolver = {}, {}, {}, { isLimbJoint = function() return false end }
local clips = {}
for i = 1, 101 do table.insert(clips, { id = "clip-" .. i, name = "Same clip name", createdAt = "2026-09-11", kind = "animation" }) end
local encoded = {}
local HttpService = { GenerateGUID = function() return "fixture-session" end,
    JSONEncode = function(_, value) local key = "fixture-json-" .. (#encoded + 1); table.insert(encoded, value); return key end,
    JSONDecode = function(_, value) return encoded[tonumber(string.match(value, "%d+$"))] end }
function HttpService:RequestAsync(input)
    table.insert(requests, input)
    local body = self:JSONDecode(input.Body)
    local result
    if string.find(input.Url, "/library/list", 1, true) then
        assert(body.kind == "animation", "Dropdown must request only animations")
        result = { assets = {}, nextOffset = body.offset == 0 and 100 or nil }
        for i = body.offset + 1, math.min(body.offset + 100, #clips) do table.insert(result.assets, clips[i]) end
    elseif string.find(input.Url, "/library/read", 1, true) then
        result = { id = body.id, recipe = { kind = "animation", name = body.id } }
        if changeDuringRead then selection = { { id = "changed-rig", name = "Changed" } } end
    else error("Unexpected fixture endpoint") end
    return { Success = true, StatusCode = 200, Body = self:JSONEncode(result) }
end
local game = { Name = "Plugin fixture", GetService = function(_, name)
    if name == "HttpService" then return HttpService end
    if name == "RunService" then return { IsRunning = function() return false end, RenderStepped = event(), Heartbeat = event() } end
    if name == "UserInputService" then return { InputBegan = event(), InputChanged = event(), InputEnded = event(), GetFocusedTextBox = function() return nil end, IsKeyDown = function() return false end, GetMouseLocation = function() return Vector3.new() end } end
    if name == "TweenService" then return { Create = function(_, target, _, properties) return { Play = function() for key, value in properties do target[key] = value end end, Cancel = function() end } end } end
    if name == "ChangeHistoryService" then return { TryBeginRecording = function() return "recording" end, FinishRecording = function() end } end
    return {}
end }
local TweenInfo = { new = function(...) return {...} end }
local workspace = { GetDescendants = function() return {} end }

local fixtureUI
local function boot()
-- INSERT_PLUGIN_HERE
fixtureUI = UI
end
boot()
local function named(name)
    for _, item in instances do if item.Name == name then return item end end
    error("Missing plugin control: " .. name)
end
assert(named("RigViewport").ClassName == "ViewportFrame")
assert(fixtureUI.pointerPosition() == relativePointer, "plugin hit tests use widget-relative pointer coordinates rather than global mouse position")
assert(named("AnimationDropdown").ClassName == "ScrollingFrame")
assert(named("AddAnimationEvent").Text == "+ Event")
assert(named("RemoveAnimationEvent").Active == false)
assert(named("Timeline").Name == "Timeline")
assert(named("JointTransformToolbar").Visible == false)
assert(named("JointManipulator").Visible == false)
assert(named("IKTargetHalo").Visible == false)
for _, name in { "GizmoSelect", "GizmoMove", "GizmoRotate", "GizmoIK", "IKEffectorLeftHand", "IKEffectorRightHand", "IKEffectorLeftFoot", "IKEffectorRightFoot" } do named(name) end
named("GizmoIK").Activated:Fire()
assert(named("IKEffectorRow").Visible == true, "IK mode should expose hand and foot effectors")
named("GizmoMove").Activated:Fire()
assert(named("IKEffectorRow").Visible == false, "Move mode should hide IK effector choices")
local editorPosition = named("Editor").Position
local editorSize = named("Editor").Size
named("AnimationLibrary").MouseEnter:Fire()
assert(named("Editor").Position[2] == editorPosition[2] and named("Editor").Size[2] == editorSize[2], "hover must not shift workspace geometry")
named("PinLibrary").MouseButton1Click:Fire()
assert(named("Editor").Position[2] == 270, "explicit pin reserves sidebar space")
named("PinLibrary").MouseButton1Click:Fire()
assert(named("Editor").Position[2] == 52, "unpin restores rail reservation without calling a nonexistent hover API")
named("AnimationLayersToggle").Activated:Fire()
assert(fixtureUI.layerPanel.Visible == true, "layer refresh must not fail on a missing toggle member")
assert(fixtureUI.layerPanel.Parent == named("AnimationInspector"))
fixtureUI.keyEditor.Visible = true
fixtureUI.selectInspector(fixtureUI.keyEditor)
assert(fixtureUI.layerPanel.Visible == false and fixtureUI.keyEditor.Visible == true, "only one editing panel occupies inspector slot")
assert(fixtureUI.viewport.Size[2] == -340, "visible inspector reserves viewport width")
fixtureUI.keyEditor.Visible = false
fixtureUI.layoutEditor()
assert(fixtureUI.viewport.Size[2] == -20, "closing inspector restores viewport width")
named("AnimationSettingsToggle").Activated:Fire()
assert(fixtureUI.settingsPanel.Visible and fixtureUI.inspector.Visible, "settings drawer is discoverable")
assert(fixtureUI.onionSkinButton.Parent == fixtureUI.settingsPanel, "advanced controls leave the camera surface")
assert(fixtureUI.frameRigButton.Parent == fixtureUI.viewport, "framing remains available without opening settings")
fixtureUI.keyEditor.Visible = true
fixtureUI.selectInspector(fixtureUI.keyEditor)
assert(not fixtureUI.settingsPanel.Visible, "pose editing closes settings instead of stacking panels")
named("AnimationSettingsToggle").Activated:Fire()
assert(not fixtureUI.keyEditor.Visible and fixtureUI.settingsPanel.Visible)
named("AnimationSettingsToggle").Activated:Fire()
assert(not fixtureUI.settingsPanel.Visible and not fixtureUI.inspector.Visible, "settings toggle restores the clear viewport")
fixtureUI.keyEditor.Visible = true
fixtureUI.selectInspector(fixtureUI.keyEditor)
fixtureUI.keyTimeBox.Text = "1.250"
named("CloseAnimationInspector").Activated:Fire()
assert(not fixtureUI.inspector.Visible and not fixtureUI.keyEditor.Visible)
assert(fixtureUI.viewport.Size.X.Offset == -20 and fixtureUI.keyTimeBox.Text == "1.250", "closing inspector restores view without resetting editing fields")
assert(fixtureUI.inspectorCloseButton.Parent == named("AnimationInspectorHeader"), "close action must stay outside scrolling content")
fixtureUI.settingsPanel.Visible = true
fixtureUI.selectInspector(fixtureUI.settingsPanel)
fixtureUI.inspector.CanvasPosition = { 0, 180 }
fixtureUI.selectInspector(fixtureUI.settingsPanel)
assert(fixtureUI.inspector.CanvasPosition[2] == 180, "refreshing the same panel preserves scroll")
fixtureUI.keyEditor.Visible = true
fixtureUI.selectInspector(fixtureUI.keyEditor)
assert(fixtureUI.inspector.CanvasPosition[2] == 0, "switching panels starts at the top")
named("CloseAnimationInspector").Activated:Fire()
assert(not fixtureUI.inspectorHeader.Visible)
assert(fixtureUI.keyEditorJoint.Size.X.Offset == -98, "joint name reserves space for the time field")
assert(fixtureUI.draftStateBadge.Position.Y.Offset >= fixtureUI.settingsToggleButton.Position.Y.Offset + fixtureUI.settingsToggleButton.Size.Y.Offset,
    "draft status badge must not cover Settings")
fixtureUI.snapToggleButton.TextSize = 8
fixtureUI.snapToggleButton:GetPropertyChangedSignal("TextSize"):Fire()
assert(fixtureUI.snapToggleButton.TextSize == 12, "small control-text assignments preserve the readability floor")
fixtureUI.editor.AbsoluteSize = { X = 1000, Y = 700 }
fixtureUI.timelineHeight = 360
fixtureUI.layoutEditor()
assert(fixtureUI.timeline.Size.Y.Offset == 360)
assert(fixtureUI.viewport.Size.Y.Offset == -400)
assert(fixtureUI.ruler.Size.Y.Scale == 1 and fixtureUI.ruler.Size.Y.Offset == -104)
assert(fixtureUI.trackNames.Size.Y.Offset == -124 and fixtureUI.trackNames.Position.Y.Offset == 56, "names and tracks retain the same content height and origin")
assert(fixtureUI.scrubber.Parent == fixtureUI.timelineTransport and fixtureUI.timelineTransport.Position.Y.Offset == -60)
fixtureUI.timelineHeight = 1000
fixtureUI.layoutEditor()
assert(fixtureUI.timelineHeight == 440, "resizing preserves a minimum viewport height")
fixtureUI.timelineHeight = 20
fixtureUI.layoutEditor()
assert(fixtureUI.timelineHeight == 216, "transport and track headers retain their minimum space")
fixtureUI.editor.AbsoluteSize = { X = 430, Y = 500 }
fixtureUI.layoutEditor()
assert(fixtureUI.timelineHeight >= 248, "compact header reserves its own second row")
assert(fixtureUI.saveButton.Position.Y.Offset == 37 and fixtureUI.selectedLabel.Size.X.Offset == -20)
assert(fixtureUI.ruler.Position.Y.Offset == 68 and fixtureUI.trackNames.Position.Y.Offset == 88)
assert(fixtureUI.status.Size.X.Offset == -20, "status keeps positive width at compact sizes")
assert(fixtureUI.addEventButton.Parent == fixtureUI.settingsPanel and fixtureUI.compressClipButton.Parent == fixtureUI.settingsPanel,
    "secondary actions remain discoverable without crowding playback controls")
fixtureUI.viewport.Visible = true
fixtureUI.viewport.AbsolutePosition = { X = 100, Y = 100 }
fixtureUI.viewport.AbsoluteSize = { X = 400, Y = 300 }
fixtureUI.library.Visible = true
fixtureUI.library.AbsolutePosition = { X = 0, Y = 100 }
fixtureUI.library.AbsoluteSize = { X = 52, Y = 500 }
assert(fixtureUI.viewportPointAvailable({ X = 150, Y = 200 }), "unobstructed camera surface accepts input")
fixtureUI.settingsToggleButton.Visible = true
fixtureUI.settingsToggleButton.AbsolutePosition = { X = 200, Y = 130 }
fixtureUI.settingsToggleButton.AbsoluteSize = { X = 100, Y = 28 }
assert(not fixtureUI.viewportPointAvailable({ X = 210, Y = 140 }), "viewport toolbar click cannot select or manipulate a joint")
fixtureUI.library.AbsoluteSize = { X = 270, Y = 500 }
assert(not fixtureUI.viewportPointAvailable({ X = 150, Y = 200 }), "hover overlay blocks the covered camera area")
fixtureUI.library.AbsoluteSize = { X = 52, Y = 500 }
fixtureUI.rigSwitchModal.Visible = true
assert(not fixtureUI.viewportPointAvailable({ X = 150, Y = 200 }), "confirmation modal blocks camera input")
fixtureUI.rigSwitchModal.Visible = false
print("Studio plugin UI boot: viewport, rig library, transform modes, limb selectors and IK mode switching passed")
