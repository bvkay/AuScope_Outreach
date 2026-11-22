# Notes on the tools

Why some checks and choices are the way they are. Each script's own header states what it does
and what would make its check fail; this file keeps the history behind them.

## make_vti.py: mismatch is measured by volume, not by cell count

20 Nov 2026, Vulcan 2022 Model 1. The first criterion was "no more than 5 % of cells differ" and
it failed at 7.4 %. The cause is real, not a bug: 97 of the model's 134 layers are thinner than
one voxel (161 m at nz = 128; the thinnest is 5 m), so several thin near-surface cells share one
voxel. Mismatch was 17 % of cells in the top 500 m, about 2 % from 500 m to 2 km, and 0 % below
2 km; 0.23 % by volume.

The uniform volume therefore cannot show the top few hundred metres faithfully. The script prints
the top-500 m figure on every run so that limit stays visible.

## make_sites.py: positions come from the header, not the INFO block

On Vulcan 2022 the decimal LATITUDE in the >INFO block disagrees with the >HEAD LAT line. For
site A1 the header gives -30:8:45.208 (-30.1459) and the INFO block gives -29.8541, which is the
header value with the minutes added the wrong way for a southern latitude.

## make_fit.py: site names are compared with repeated underscores collapsed

Geotools writes a doubled underscore in its output names where the input EDI has one (input
"J6_BxRepaced", output "J6__BxRepaced"). The first run of check 5 failed on exactly those seven
renamed sites. Their header LAT and LONG are identical in the input and output EDIs, so it is a
naming difference and not a wrong pairing.

## make_aspect_section.py: the grid spans every time step

20 Nov 2026, sandiford-2021-detachment. Taking the grid from the first time step cut off the top
1.3 km of the last one, because the surface rises as the footwall is exhumed. That is where the
plastic strain is largest, and the plastic-strain check failed with a correlation of 0.71.

## fetch_records.py: Vulcan is read from the package README

The Kay-2024-Vulcan repository was not on the live site or on GitHub on 20 Nov 2026.
