import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { Blender } from '../dist/src/blender.js';
import { animationPreset } from '../dist/src/recipes.js';

const root = resolve('.');
const executable = process.env.BLENDER_EXECUTABLE ?? join(root, '.local/tools/blender-4.5.0-windows-x64/blender.exe');
const directory = join(root, '.local/blender-test');
await mkdir(directory, { recursive: true });
const fixturePath = join(directory, 'fixture.blend');
const fixtureScript = join(directory, 'fixture.py');
await writeFile(fixtureScript, `import bpy\nfrom mathutils import Vector\nbpy.ops.object.select_all(action='SELECT')\nbpy.ops.object.delete(use_global=False)\nparts=[]\ndef cube(name, location, scale):\n    bpy.ops.mesh.primitive_cube_add(size=1, location=location)\n    obj=bpy.context.object\n    obj.name=name\n    obj.scale=scale\n    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)\n    parts.append(obj)\ncube('Torso',(0,0,1.3),(.5,.3,.65))\ncube('Head',(0,0,1.85),(.3,.3,.3))\nfor side in [-1,1]:\n    cube('Arm',(side*.7,0,1.6),(.9,.18,.18))\n    cube('Leg',(side*.16,0,.55),(.2,.22,1.1))\nbpy.ops.object.select_all(action='DESELECT')\nfor part in parts: part.select_set(True)\nbpy.context.view_layer.objects.active=parts[0]\nbpy.ops.object.join()\nbpy.context.object.name='FixtureBody'\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(fixturePath)})\n`);
async function run(args) {
  let log = '';
  await new Promise((done, fail) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timeout = setTimeout(() => { child.kill(); fail(new Error('Fixture operation timed out.')); }, 120000);
    child.stdout.on('data', x => { log += x; }); child.stderr.on('data', x => { log += x; });
    child.once('error', e => {
      clearTimeout(timeout);
      fail(new Error(`Could not launch Blender at "${executable}": ${e.message}. Install Blender, run scripts/bootstrap-blender.ps1, or set BLENDER_EXECUTABLE to your Blender executable.`));
    });
    child.once('close', code => { clearTimeout(timeout); code === 0 ? done() : fail(new Error(log)); });
  });
  return log;
}
await run(['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', fixtureScript]);
const blender = new Blender(root, executable);
const before = await readFile(fixturePath);
const inspected = await blender.run(fixturePath, { operation: 'inspect' });
assert.equal(inspected.objects[0].name, 'FixtureBody');
const rigged = await blender.run(fixturePath, { operation: 'rig_humanoid', mesh: 'FixtureBody', name: 'FixtureRig', bind: true });
assert.equal(rigged.weights.unweighted, 0);
assert.equal(rigged.weights.overFourInfluences, 0);
assert.equal(rigged.weights.notNormalized, 0);
const rigReport = await blender.run(rigged.blendFile, { operation: 'inspect' });
assert.equal(rigReport.objects.find(x => x.kind === 'ARMATURE').bones.length, 16);
const animated = await blender.run(rigged.blendFile, { operation: 'animate', armature: 'FixtureRig', recipe: animationPreset('cast', 'Fixture Cast', 2, 1), jointMap: {} });
assert.ok(animated.curves > 0);
const exportResult = await blender.run(animated.blendFile, { operation: 'export_fbx', armature: 'FixtureRig' });
assert.ok((await stat(exportResult.fbx)).size > 1000);
assert.deepEqual(await readFile(fixturePath), before, 'Original fixture must remain byte-identical');
await writeFile(join(directory, 'results.json'), JSON.stringify({ inspected, rigged, animated, exported: exportResult }, null, 2));
await run(['--background', '--factory-startup', '--disable-autoexec', animated.blendFile, '--python-exit-code', '1', '--python', join(root, 'blender/verify_fixture.py'), '--', directory]);
console.log('Blender smoke passed: 16 bones, valid weights, mesh deformation, animation action, FBX roundtrip, original preserved.');
console.log(`Results: ${join(directory, 'results.json')}`);
