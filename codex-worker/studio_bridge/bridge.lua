--[[ Studio bridge client. Served by tools/studio_bridge/server.py at /bridge.lua.

Load it inside execute_luau (Edit mode):
	local B = loadstring(game:GetService("HttpService"):GetAsync("__BRIDGE_BASE__/bridge.lua", true))()

	B.pull(inst, "my-task/Foo.lua")          -- Studio source -> <root>/my-task/Foo.lua, returns its hash
	B.load("my-task/Foo.lua", inst)          -- compile the local copy and return a fresh module
	B.push(inst, "my-task/Foo.lua")          -- write the copy to Studio once; aborts if Studio changed
	B.status(inst, "my-task/Foo.lua")        -- final check: {same, live, local, base, ...}

execute_luau shows only the first return value; tables come back as JSON.
Every failure is an error() whose message starts with "[bridge]".
]]

local HttpService = game:GetService("HttpService")
local ScriptEditorService = game:GetService("ScriptEditorService")

local B = {}
B.base = "__BRIDGE_BASE__"

local function fail(fmt, ...)
	error("[bridge] " .. string.format(fmt, ...), 0)
end

function B.safe(s)
	s = tostring(s)
	return utf8.len(s) and s or "<bad>"
end

function B.path(inst)
	return B.safe(inst:GetFullName())
end

-- FNV-1a 32-bit + byte length; server.py's bridge_hash() gives the same value.
function B.hash(s)
	local n = #s
	local buf = buffer.fromstring(s)
	local bxor, lshift = bit32.bxor, bit32.lshift
	local h = 2166136261
	for i = 0, n - 1 do
		h = bxor(h, buffer.readu8(buf, i))
		h = (lshift(h, 24) + h * 403) % 4294967296 -- h * 16777619 mod 2^32
	end
	return string.format("%08x-%d", h, n)
end

local function request(method, rel, body)
	local req = { Url = B.base .. "/file?name=" .. HttpService:UrlEncode(rel), Method = method }
	if body ~= nil then
		req.Body = body
		req.Headers = { ["Content-Type"] = "text/plain; charset=utf-8" }
	end
	local ok, res = pcall(HttpService.RequestAsync, HttpService, req)
	if not ok then
		fail("cannot reach %s (%s). Start it: python tools/studio_bridge/server.py", B.base, tostring(res))
	end
	return res
end

-- Local file text, or nil if it does not exist.
local function get(rel)
	local res = request("GET", rel)
	if res.StatusCode == 404 then
		return nil
	end
	if not res.Success then
		fail("GET %s failed: HTTP %d %s", rel, res.StatusCode, res.Body)
	end
	return res.Body
end

function B.read(rel)
	local text = get(rel)
	if text == nil then
		fail("no local copy %s (pull it first)", rel)
	end
	return text
end

-- Save text to <root>/<rel>; checks the server stored exactly these bytes.
function B.write(rel, text)
	local res = request("POST", rel, text)
	if not res.Success then
		fail("POST %s failed: HTTP %d %s", rel, res.StatusCode, res.Body)
	end
	local h = B.hash(text)
	local info = HttpService:JSONDecode(res.Body)
	if info.hash ~= h then
		fail("transfer of %s was altered: sent %s, server stored %s", rel, h, tostring(info.hash))
	end
	return h
end

local function getBase(rel)
	local text = get(rel .. ".base.json")
	return text and HttpService:JSONDecode(text) or nil
end

local function setBase(rel, inst, h)
	B.write(rel .. ".base.json", HttpService:JSONEncode({ hash = h, target = B.path(inst), class = inst.ClassName }))
end

-- Strip a UTF-8 BOM; turn CRLF into LF unless the live source itself uses CR.
local function normalize(text, live)
	if text:sub(1, 3) == "\239\187\191" then
		text = text:sub(4)
	end
	if not (live and live:find("\r", 1, true)) then
		text = text:gsub("\r\n", "\n")
	end
	return text
end

local function assertScript(inst, what)
	if typeof(inst) ~= "Instance" or not inst:IsA("LuaSourceContainer") then
		fail("%s needs a script instance, got %s", what, typeof(inst) == "Instance" and inst.ClassName or typeof(inst))
	end
end

-- Live source as Studio has it (the open editor's text if the script is open).
function B.source(inst)
	assertScript(inst, "source")
	local ok, s = pcall(ScriptEditorService.GetEditorSource, ScriptEditorService, inst)
	if ok and type(s) == "string" then
		return s
	end
	return inst.Source
end

-- Full local path of <rel>, from the server's root.
function B.file(rel)
	local info = HttpService:JSONDecode(HttpService:GetAsync(B.base .. "/health", true))
	return info.root .. "\\" .. rel:gsub("/", "\\")
end

-- pull(inst, rel[, {force = true}]) -> base hash. Refuses to overwrite a local copy with unpushed edits.
function B.pull(inst, rel, opts)
	opts = opts or {}
	assertScript(inst, "pull")
	if not opts.force then
		local cur = get(rel)
		if cur ~= nil then
			local meta = getBase(rel)
			local base = meta and meta.hash
			if B.hash(cur) ~= base and B.hash(normalize(cur)) ~= base then
				fail("pull refused: local copy %s has edits that were not pushed (or was not made by pull). Push it, pull to another name, or pass {force = true}", rel)
			end
		end
	end
	local src = B.source(inst)
	local h = B.write(rel, src)
	setBase(rel, inst, h)
	return h
end

-- check(rel) -> {ok = true} or {ok = false, error = "..."}; compiles only, runs nothing.
function B.check(rel)
	local fn, err = loadstring(normalize(B.read(rel)), "=" .. rel)
	return fn and { ok = true } or { ok = false, error = tostring(err) }
end

-- load(rel[, scriptInst]) -> whatever the chunk returns, from a fresh compile of the local copy.
-- scriptInst sets the chunk's `script` global so script.Parent etc. resolve.
function B.load(rel, scriptInst)
	local fn, err = loadstring(normalize(B.read(rel)), "=" .. rel)
	if not fn then
		fail("compile error in %s: %s", rel, tostring(err))
	end
	if scriptInst ~= nil then
		setfenv(fn, setmetatable({ script = scriptInst }, { __index = getfenv(fn) }))
	end
	return fn()
end

local function writeSource(inst, new, baseHash, timeout)
	local state = { done = false }
	task.spawn(function()
		local ok, err = pcall(function()
			ScriptEditorService:UpdateSourceAsync(inst, function(old)
				if B.hash(old) ~= baseHash then
					state.raced = true
					return old
				end
				return new
			end)
		end)
		state.ok, state.err, state.done = ok, err, true
	end)
	local waited = 0
	while not state.done and waited < timeout do
		waited += task.wait(0.05)
	end
	if state.raced then
		fail("push aborted: %s changed in Studio during the write; nothing was written", B.path(inst))
	end
	if state.done and state.ok then
		return "UpdateSourceAsync"
	end
	local why = state.done and ("UpdateSourceAsync failed: " .. B.safe(state.err)) or "UpdateSourceAsync timed out"
	local liveHash = B.hash(B.source(inst))
	if liveHash == B.hash(new) then
		return "UpdateSourceAsync (late)"
	end
	if liveHash ~= baseHash then
		fail("push aborted: %s changed in Studio during the write (%s)", B.path(inst), why)
	end
	inst.Source = new
	return "Source (" .. why .. ")"
end

-- push(inst, rel[, baseHash[, {timeout = 5, force = true}]]) -> {status, hash, method, bytes, target}
-- baseHash defaults to the one saved by pull. Aborts without writing if the live source no longer
-- matches it, if the copy was pulled from another script (unless force), or if the copy does not compile.
function B.push(inst, rel, baseHash, opts)
	opts = opts or {}
	assertScript(inst, "push")
	local meta = getBase(rel)
	baseHash = baseHash or (meta and meta.hash)
	if not baseHash then
		fail("push: no base hash for %s; pull first or pass the hash pull returned", rel)
	end
	local target = B.path(inst)
	if meta and meta.target ~= target and not opts.force then
		fail("push refused: %s was pulled from %s, not %s (pass {force = true} if intended)", rel, tostring(meta.target), target)
	end
	local live = B.source(inst)
	local liveHash = B.hash(live)
	if liveHash ~= baseHash then
		fail("push aborted: %s changed in Studio since pull (base %s, live %s). Another session edited it; nothing was written. Pull it to a new name, merge your edits into that copy, then push that copy.", target, baseHash, liveHash)
	end
	local new = normalize(B.read(rel), live)
	local fn, err = loadstring(new, "=" .. rel)
	if not fn then
		fail("push aborted: compile error, nothing was written: %s", tostring(err))
	end
	local newHash = B.hash(new)
	local result = { target = target, hash = newHash, bytes = #new }
	if newHash == liveHash then
		result.status = "unchanged"
		return result
	end
	result.method = writeSource(inst, new, baseHash, opts.timeout or 5)
	local after = B.hash(B.source(inst))
	if after ~= newHash then
		fail("push verify failed: %s is %s after the write, expected %s (method %s)", target, after, newHash, result.method)
	end
	setBase(rel, inst, newHash)
	result.status = "pushed"
	return result
end

-- status(inst, rel) -> {same, liveChanged, live, local, base, target}
function B.status(inst, rel)
	local live = B.source(inst)
	local meta = getBase(rel)
	local r = {
		target = B.path(inst),
		live = B.hash(live),
		["local"] = B.hash(normalize(B.read(rel), live)),
		base = meta and meta.hash,
	}
	r.same = r.live == r["local"]
	r.liveChanged = r.base ~= nil and r.live ~= r.base
	return r
end

return B
