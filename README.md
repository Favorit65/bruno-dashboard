# Ветка data-model

Здесь лежат собранные агрегаты:

* `model.core.json.gz` + `model.cubes.json.gz` — компактный формат 2,
  его грузит `dashboard_v2.html` (core сразу, cubes фоном);
* `model.json.gz` — прежний единый файл, читает конвейер презентации
  и он же запасной вариант для дашборда.

Ветка **перезаписывается** роботом `update-model.yml` при каждом
обновлении данных, история намеренно не копится (файл ~9 МБ).
Исходники — в ветке `main`, сырые данные — в ветке `data-archive`.

Скачать свежую модель локально:

    git fetch origin data-model
    git show origin/data-model:model.json.gz > model.json.gz
