// Regression for cockpit dragging: exercise the actual renderer projection methods without WebGL/DOM.
import assert from "node:assert/strict";
import * as THREE from "three";
import { SceneController } from "../src/render/sceneController";
import { SHIFTER_LAYOUT as L } from "../src/render/vehiclesAndPeds";

// Bypass the WebGL constructor; only camera, chassis and ray/plane math are needed here.
const ctrl = Object.create(SceneController.prototype);
const chassis = new THREE.Group();
const camera = new THREE.PerspectiveCamera(62, 1.6, 0.01, 100);
Object.assign(ctrl, {
  lastCameraMode: "cockpit", camera, playerRig: { chassis },
  shifterNdc: new THREE.Vector2(), shifterRaycaster: new THREE.Raycaster(),
  shifterInvChassis: new THREE.Matrix4(), shifterLocalRay: new THREE.Ray(),
  shifterPlane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -L.knobPlaneY),
  shifterLocalHit: new THREE.Vector3(), shifterProjTmp: new THREE.Vector3(),
});
const { gateZ } = ctrl.getShifterLocalAnchor();
for (const yaw of [0, 0.7, -1.2]) {
  chassis.position.set(12, 0.2, -8);
  chassis.rotation.y = yaw;
  chassis.updateMatrixWorld(true);
  camera.position.copy(chassis.localToWorld(new THREE.Vector3(0.414, 1.2, gateZ - 0.4)));
  camera.lookAt(chassis.localToWorld(new THREE.Vector3(L.mainRailX, L.knobPlaneY, gateZ)));
  camera.updateMatrixWorld(true);
  for (const [offsetX, offsetZ] of [[0, 0], [0.013, -0.027], [-0.009, 0.018]]) {
    for (const [id, x, z] of [
      ["P", L.mainRailX, L.offP], ["D", L.mainRailX, L.offD],
      ["M", L.manualRailX, L.offD], ["M+", L.manualRailX, L.offMPlus],
      ["M-", L.manualRailX, L.offMMinus],
    ] as const) {
      const p = ctrl.getShifterDragTargetScreenPoint(id, offsetX, offsetZ);
      assert.ok(p, `${id}: target must be visible`);
      const hit = ctrl.projectToShifterLocal(p.normX, p.normY);
      assert.ok(hit);
      assert.ok(Math.abs(hit.x - offsetX - x) < 1e-9, `${id}: lateral drag coordinate`);
      assert.ok(Math.abs(hit.z - offsetZ - gateZ - z) < 1e-9, `${id}: longitudinal drag coordinate`);
    }
  }
}
console.log("PASS cockpit drag projection: P/D/M/+/−, 3 grab offsets, 3 chassis headings");

// Layer regression: a correct projection/click does NOT imply the car is rendered.
// Run the production layer setup without constructing a WebGLRenderer.
Object.assign(ctrl, {
  sideCam: new THREE.PerspectiveCamera(), rearCam: new THREE.PerspectiveCamera(),
});
ctrl["configurePlayerViewLayers"]();
const world = new THREE.Layers();
const body = new THREE.Layers(); body.set(1);
const mirror = new THREE.Layers(); mirror.set(2);
assert.ok(camera.layers.test(world), "main view must retain world visibility");
assert.ok(camera.layers.test(body), "main view must show player body AND cockpit");
assert.ok(camera.layers.test(mirror), "main view must show physical mirror hardware");
assert.ok(ctrl.sideCam.layers.test(body), "side mirrors must show own car edge");
assert.ok(!ctrl.sideCam.layers.test(mirror), "side mirrors must not render their own hardware");
assert.ok(!ctrl.rearCam.layers.test(body), "rear mirror must not be blocked by own car");
assert.ok(ctrl.shifterRaycaster.layers.test(body), "cabin pick meshes must remain interactive");
console.log("PASS player camera layers: world, body/cockpit, mirrors and picking");

// Own trunk is a lower-frame distance reference; the roof/interior stay excluded.
const own = new THREE.Group();
const trunk = new THREE.Mesh(new THREE.BoxGeometry(1.78, 0.588, 0.87));
const deck = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.6));
deck.userData.rearMirrorOnly = true;
const roof = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.055, 2));
const hardware = new THREE.Mesh(); hardware.layers.set(2);
own.add(trunk, deck, roof, hardware);
ctrl["configurePlayerMeshLayers"](own);
assert.ok(ctrl.rearCam.layers.test(deck.layers), "rear mirror must show upper rear surface");
assert.ok(!ctrl.rearCam.layers.test(trunk.layers), "solid trunk box must not appear as a floating block");
assert.ok(!camera.layers.test(deck.layers), "mirror surface must not duplicate exterior geometry");
assert.ok(!ctrl.rearCam.layers.test(roof.layers), "roof must not obscure rear view");
assert.ok(!ctrl.rearCam.layers.test(hardware.layers), "no mirror self-reflection");
assert.ok(camera.layers.test(trunk.layers), "trunk remains visible in main view");

// Same pose/FOV as the actual HUD rear mirror; the top of the trunk lies at the bottom.
const rear = new THREE.PerspectiveCamera(38, 10 / 3, 0.06, 112);
rear.position.set(0, 1.24, 0.25);
rear.lookAt(0, 1.24 - 0.08, -0.75);
rear.updateMatrixWorld(true);
const trunkTop = new THREE.Vector3(0, 0.24 + 0.588, -1.6).project(rear);
assert.ok(trunkTop.y > -1 && trunkTop.y < -0.25, "trunk reference is visible in lower mirror, not covering road");
console.log("PASS rear mirror: trunk visible below road, roof/interior excluded");
