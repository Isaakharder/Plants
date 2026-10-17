# Synthetic Ridder Synopta "Block Summary" exports for the climate tests.
#
# Same structure as the real exports (row and column layout, labels, 22 zones,
# 3 trailing empty columns, quoted cells, "Real time - hh:mm" values, the
# dd/mm/yyyy header with a month-first value, Windows-1252 bytes) but every
# measurement is fictional. Real exports are never committed: Plants is public.
#
#   python3 supabase/functions/_shared/climate/fixtures/generate.py
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ZONES = 22


def row(label, cells):
    cells = list(cells) + [''] * (ZONES - len(cells))
    return [label] + cells + ['', '', '']


def only(zones, value):
    """A value reported only under some zones (blank elsewhere)."""
    return [value if z in zones else '' for z in range(1, ZONES + 1)]


def export(date_mdy, time_hhmm, week, seed, radiation, irrigation, eol):
    s = seed
    rows = [
        [''] * (ZONES + 4),
        ['Block heating'] + [f'Zone {z}' for z in range(1, ZONES + 1)] + ['', '', ''],
        row('Air temperature [°C]', [f'{18.0 + s + (z * 7 % 11) / 5:.1f}' for z in range(1, ZONES + 1)]),
        row('RH [%]', [str(60 + (z * 5 + s * 3) % 30) for z in range(1, ZONES + 1)]),
        # CO2 and EC repeat across groups of zones, as shared sensors do.
        row('CO2 concentration [ppm]', [str(410 + 10 * ((z - 1) // 4) + s) for z in range(1, ZONES + 1)]),
        row('Radiation sum [J/cm²]', only({1, 15}, radiation)),
        # Zone 7 reports 0.0 EC (suspicious); every zone reports 0.0 pH (sensor not reporting).
        row('Average EC [mS/cm]', ['0.0' if z == 7 else ('2.6' if z <= 14 else '1.7' if z <= 18 else '2.9') for z in range(1, ZONES + 1)]),
        row('Average pH', ['0.0'] * ZONES),
        row('Cumulative irrigation (dripper) [ml/dripp]', [irrigation] * ZONES),
        row('Cumulative drain water percentage [%]', only({1, 15}, '0.0')),
        row('Group activation time [hh:mm]', only({1, 15}, 'Real time - --:--')),
        row('Weather system', ['System']),
        row('System time [hh:mm]', [f'Real time - {time_hhmm}']),
        row('System date [dd/mm/yyyy]', [date_mdy]),
        row('Week number', [str(week)]),
        row('Sunrise today [hh:mm]', ['Real time - 06:30']),
        row('Sunset today [hh:mm]', ['Real time - 19:30']),
        [''] * (ZONES + 4),
    ]
    text = eol.join(','.join(f'"{c}"' for c in r) for r in rows) + eol
    return text.encode('cp1252')


FILES = {
    # CRLF, as the climate computer writes them.
    'Block Summary_20261017_100009.csv': export('10/17/2026', '10:00', 42, 3, '96.5', '0', '\r\n'),
    # LF variants (as stored in the agent's repository).
    'Block Summary_20260717_080003.csv': export('7/17/2026', '08:00', 29, 1, '12.5', '0', '\n'),
    'Block Summary_20260717_090003.csv': export('7/17/2026', '09:00', 29, 2, '61.0', '35', '\n'),
    'Block Summary_20260717_100005.csv': export('7/17/2026', '10:00', 29, 4, '138.2', '120', '\n'),
    'Block Summary_20260717_110006.csv': export('7/17/2026', '11:00', 29, 5, '231.7', '240', '\n'),
}

if __name__ == '__main__':
    for name, data in FILES.items():
        with open(os.path.join(HERE, name), 'wb') as f:
            f.write(data)
        print(name, len(data), 'bytes')
