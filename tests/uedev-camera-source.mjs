// Статические регрессии адаптера камеры; НЕ компиляция UE и НЕ визуальный тест.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const base='ue/UEDev/Source/UEDev/Private/';
const pawn=readFileSync(base+'UEDevPawn.cpp','utf8');
const controller=readFileSync(base+'UEDevPlayerController.cpp','utf8');
const bindings=[...`${pawn}\n${controller}`.matchAll(/BindKey\(EKeys::(\w+),\s*(IE_\w+)/g)].map(m=>`${m[1]}:${m[2]}`);
assert.equal(new Set(bindings).size,bindings.length,'one key event must have one action');
for (const key of ['C','One','Two']) assert(bindings.includes(`${key}:IE_Pressed`));
function body(name) {
  const start=pawn.indexOf(`void AUEDevPawn::${name}(`);
  assert(start>=0,`missing ${name}`);
  const open=pawn.indexOf('{',start);
  let depth=1,end=open+1;
  for (;end<pawn.length && depth;end++) {
    if (pawn[end]==='{') depth++;
    if (pawn[end]==='}') depth--;
  }
  return pawn.slice(open,end);
}
for (const name of ['ToggleCamera','ExteriorView','InteriorView','ApplyCameraView']) {
  assert(!/\b(?:Reset|Ready|SetRoute)\s*\(|\b(?:Model|Run|Accumulator)\s*[.=]/.test(body(name)),`${name} must not mutate ride state`);
}
assert(body('ApplyCameraView').includes('Camera->SetActive(!CabinView)'));
assert(body('ApplyCameraView').includes('CabinCamera->SetActive(CabinView)'));
assert(body('ApplyCameraView').includes('Detail->SetVisibility(!CabinView)'));
assert(pawn.includes('PartName==TEXT("PaintCabin") || PartName.StartsWith(TEXT("Glass"))'));
assert(pawn.includes('SetCollisionEnabled(ECollisionEnabled::NoCollision)'));
assert(body('MouseX').includes('if (CabinView)'));
assert(body('MouseY').includes('if (CabinView)'));
assert(body('Zoom').indexOf('LeftControl')<body('Zoom').indexOf('else if (CabinView)'),'Ctrl wheel retains gas precedence');
assert(body('InteriorView').includes('SetRelativeRotation(FRotator(-5,0,0))'));
assert(body('Tick').includes('SteeringPivot->SetRelativeRotation(FRotator(0,0,-Model.WheelDeg))'));
console.log('PASS UEDev camera source guards: bindings, independent ride state, active cameras, occluders, input branches (not UE runtime)');

const hud=readFileSync(base+'UEDevHUD.cpp','utf8');
assert(body('UpdateCabin').includes('Down(EKeys::Left),Down(EKeys::Right)'));
assert(!/EKeys::(?:Up|Down)\b/.test(body('UpdateCabin')),'up/down remain gearbox only');
assert(pawn.includes('Target->InitAutoFormat(320,Index==0 ? 96 : 160)'));
assert(pawn.includes('Capture->bCaptureEveryFrame = false'));
assert(pawn.includes('Capture->bCaptureOnMovement = false'));
assert(body('UpdateCabin').includes('1.f/15.f'));
assert(pawn.includes('MirrorCaptures[Index]->HideComponent(DashboardDisplay)'));
assert(body('UpdateCabin').includes('Model.Rpm') && body('UpdateCabin').includes('Model.AutoGear'));
assert(hud.indexOf('Mirror(0,')<hud.indexOf('if (!PanelsVisible) return;'),'mirrors survive HUD hiding');
assert(hud.includes('H*Scale,1,0,-1,1'),'mirror image must flip U');
console.log('PASS UEDev mirror/instrument source guards (not Unreal render/compile)');

for (const key of ['F5','F6','F7']) assert(bindings.includes(`${key}:IE_Pressed`));
assert(hud.includes('IsMirrorEnabled(Index)'));
assert(body('UpdateCabin').includes('MirrorEnabled[Index]'));
assert(body('ToggleHud').includes('TogglePanels()'),'H must not disable entire AHUD render path');
assert(!body('ToggleHud').includes('ShowHUD()'));

// Log-4: checked-format UE 5.7 не принимает условный const TCHAR* вместо литерала.
for (const source of [pawn,controller,hud]) {
  const total=[...source.matchAll(/FString::Printf\s*\(/g)].length;
  const literal=[...source.matchAll(/FString::Printf\s*\(\s*TEXT\s*\(\s*"/g)].length;
  assert.equal(total,literal,'FString::Printf must receive a direct TEXT literal');
}
assert(body('UpdateCabin').includes('HeadControl.Step('));
console.log('PASS UEDev checked-format literal guards (Log-4 regression, not UE compile)');

assert(pawn.includes('DeltaSeconds,HeadReturnSpeed)'));
assert(controller.includes('TEXT("HeadReturnRate")'));
assert(controller.includes('SetHeadReturnRate(HeadReturnSetting)'));

assert(hud.includes('if (!DrivingPawn->IsCabinView())'));
assert(pawn.includes('SetWidgetSpace(EWidgetSpace::World)'));
assert(pawn.includes('SetSlateWidget(SNew(SImage)'));
assert(pawn.includes('SetUVRegion(FBox2f(FVector2f(1,0),FVector2f(0,1)))'));
assert(pawn.includes('HideComponent(SurfaceWidget.Get())'));
assert(pawn.includes('MirrorBrushes.SetNum(3)'));
console.log('PASS physical mirror source guards (not Unreal compile/render)');
