# Dot Field

Экспериментальная weather visualization system для осадков и опасных погодных явлений, построенная вокруг детерминированного пространственного поля и стабильной сетки данных.

🔗 Опубликованный прототип из `main`: [anatolysinelnikov.github.io/dot-field](https://anatolysinelnikov.github.io/dot-field/)

## Текущий `real-data` runtime

В ветке `real-data` активны три представления одной и той же нормализованной погодной последовательности:

**RAW** — диагностическое отображение точных source-grid значений без пространственной или временной интерполяции.

**Dots** — детерминированная Mercator grid/LOD визуализация, где интенсивность осадков передаётся прежде всего радиусом и перекрытием точек.

**Squares** — использует ту же canonical grid/LOD identity, но отображает поле квадратами.

**Blur** и **Areas** остаются реализованными в репозитории, но временно не включены в текущий runtime до viewport-windowed scalar reconstruction.

Реальные данные подготавливаются локально из NetCDF в ignored `data/generated/` и загружаются браузером через immutable generated weather generations. Подробный data flow, spatial/LOD contracts и runtime ownership описаны в [`ARCHITECTURE.md`](ARCHITECTURE.md).

`data/mrl_z3_t+40min_376x239.csv` сохранён как старый sample/fixture с thunderstorm/hail для ручной и автоматизированной отладки явлений. Приложение не использует его как fallback: текущий `real-data` runtime требует подготовленную generated weather sequence.

![Dot Field](assets/dot-field.jpg)
