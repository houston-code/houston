# geokit changelog

## 3.0.0

Breaking:

- Points are objects, `{ lat, lng }`, made with `point(lat, lng)`. 2.x used `[lat, lon]` arrays.
- `distance(a, b)` returns **metres**. 2.x returned kilometres.
- `bearing(a, b)` is renamed `initialBearing(a, b)`. It returns degrees in [0, 360);
  2.x returned (-180, 180].

## 2.4.1

- Fix `distance` near the antimeridian.
