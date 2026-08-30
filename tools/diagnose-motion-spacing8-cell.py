"""Small companion to diagnose-motion-reliability.py for tracked-cell spacing-8 output."""
import contextlib, importlib.util, io, math
spec = importlib.util.spec_from_file_location("diagnostic", "tools/diagnose-motion-reliability.py")
d = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(d)

def at(values, x, y, component, spacing):
    gh, gw = values.shape[1:]; mx, my = x / spacing, y / spacing
    x0, y0 = min(gw - 2, max(0, math.floor(mx))), min(gh - 2, max(0, math.floor(my)))
    fx, fy = min(1, max(0, mx - x0)), min(1, max(0, my - y0))
    low = values[component, y0, x0] + (values[component, y0, x0 + 1] - values[component, y0, x0]) * fx
    high = values[component, y0 + 1, x0] + (values[component, y0 + 1, x0 + 1] - values[component, y0 + 1, x0]) * fx
    return float(low + (high - low) * fy)

for i, (source, target) in enumerate(zip(d.frames[:-1], d.frames[1:])):
    forward, fd = d.diagnostic_estimate(source, target, 8); backward, bd = d.diagnostic_estimate(target, source, 8)
    a, b = d.tracks[i], d.tracks[i + 1]; cx, cy = (a["x"] + b["x"]) / 2, (a["y"] + b["y"]) / 2
    def relevant(details):
        x0 = min(len(details[0]) - 2, max(0, math.floor(cx / 8))); y0 = min(len(details) - 2, max(0, math.floor(cy / 8)))
        return [details[y][x] for y in range(y0, y0 + 2) for x in range(x0, x0 + 2)]
    rf, rb = relevant(fd), relevant(bd)
    print(i, d.metadata["time"]["timestamps"][i][11:16], "F", round(at(forward, a["x"], a["y"], 0, 8), 2), round(at(forward, a["x"], a["y"], 1, 8), 2), "B", round(at(backward, b["x"], b["y"], 0, 8), 2), round(at(backward, b["x"], b["y"], 1, 8), 2), "direct", sum(x["state"] == "direct" for x in rf), sum(x["state"] == "direct" for x in rb), "zero", sum(x["state"] == "zero fallback" for x in rf), sum(x["state"] == "zero fallback" for x in rb), "filled", sum(x["state"] == "filled" for x in rf), sum(x["state"] == "filled" for x in rb))
