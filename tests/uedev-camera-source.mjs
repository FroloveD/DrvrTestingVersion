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
