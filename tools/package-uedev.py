"""Архив исходников UEDev (без SDK, ассетов сборки и кэшей). Запуск из любой папки."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
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
    archive.writestr('UEDev-starter/START_HERE.txt', '''UEDev — UE 5.6 C++: стартовое меню, пауза и технический итог.
Распакуйте архив целиком. Прочтите ue/README.md и ue/PLAN.md.
Откройте ue/UEDev/UEDev.uproject, соберите UEDevEditor.
Play -> стартовое меню -> Начать заезд -> Enter -> W.
Esc в Standalone: пауза (в PIE редактор может перехватить Esc).
Маршруты, редактор, настройки и журнал ещё не портированы.
Нет UE SDK/EXE. UE-сборка и UI НЕ проверены; проверены только переносимые C++-тесты.
NOTICE сохранён из исходного репозитория; архив не предоставляет новых лицензионных прав.
''')
with ZipFile(out) as archive:
    if archive.testzip() is not None:
        raise RuntimeError('Повреждённый ZIP')
    assert 'UEDev-starter/ue/UEDev/UEDev.uproject' in archive.namelist()
    print(f'{out}: {len(archive.namelist())} файлов, {out.stat().st_size} байт; ZIP проверен')
