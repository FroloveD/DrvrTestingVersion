"""Архив исходников UEDev (без SDK, ассетов сборки и кэшей). Запуск из любой папки."""
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
project = root / 'ue' / 'UEDev'
descriptor = (project / 'UEDev.uproject').read_bytes()
# Не допускать UTF-16 и BOM: UBT читает descriptor как UTF-8 JSON.
assert not descriptor.startswith((b'\xff\xfe', b'\xfe\xff', b'\xef\xbb\xbf'))
assert json.loads(descriptor.decode('utf-8'))['EngineAssociation'] == '5.7'
for target in ['UEDev.Target.cs', 'UEDevEditor.Target.cs']:
    assert 'BuildSettingsVersion.V6' in (project / 'Source' / target).read_text(encoding='utf-8')
# Регрессии C1083 из Log-2/Log-3: используем компонент, не заголовок актора.
scene = (project / 'Source/UEDev/Private/UEDevGameMode.cpp').read_text(encoding='utf-8')
assert '#include "Components/SkyAtmosphereComponent.h"' in scene
assert '#include "Atmosphere/SkyAtmosphere.h"' not in scene
assert 'SpawnActor<ASkyAtmosphere>' not in scene
assert '#include "Engine/SkyAtmosphere.h"' not in scene
out = root / 'deliverables' / 'UEDev-menu-starter.zip'
out.parent.mkdir(exist_ok=True)
skip = {'Binaries', 'DerivedDataCache', 'Intermediate', 'Saved', '.vs', '__pycache__'}
with ZipFile(out, 'w', ZIP_DEFLATED) as archive:
    for path in sorted((root / 'ue').rglob('*')):
        if path.is_file() and not any(p in skip for p in path.relative_to(root / 'ue').parts):
            if path.suffix.lower() in {'.sln', '.suo', '.zip'} or '.vcxproj' in path.name:
                continue
            archive.write(path, 'UEDev-starter/' + path.relative_to(root).as_posix())
    archive.write(root / 'NOTICE', 'UEDev-starter/NOTICE')
    archive.writestr('UEDev-starter/START_HERE.txt', '''UEDev — UE 5.7 C++: стартовое меню, пауза и технический итог.
Ревизия набора: fast-head-return-540-900; HUD TEXT-format fix Log-4/Log-5.
Распакуйте архив целиком В НОВУЮ ПАПКУ. Прочтите ue/README.md и ue/PLAN.md.
Откройте ue/UEDev/UEDev.uproject, соберите UEDevEditor.
Play -> стартовое меню -> Начать заезд -> удерживать S и нажать Enter -> отпустить S -> W.
Backspace — холодный сброс; Enter не сбрасывает заезд; L — фары.
Esc в Standalone: пауза (в PIE редактор может перехватить Esc).
Два тестовых маршрута, настройки газа, итоги в памяти; low-poly машина и дневной свет.
Полный редактор, постоянный журнал и реплей ещё не портированы.
Нет UE SDK/EXE. UE-сборка и UI НЕ проверены; проверены только переносимые C++-тесты.
NOTICE сохранён из исходного репозитория; архив не предоставляет новых лицензионных прав.
''')
with ZipFile(out) as archive:
    if archive.testzip() is not None:
        raise RuntimeError('Повреждённый ZIP')
    assert 'UEDev-starter/ue/UEDev/UEDev.uproject' in archive.namelist()
    print(f'{out}: {len(archive.namelist())} файлов, {out.stat().st_size} байт; ZIP проверен')
