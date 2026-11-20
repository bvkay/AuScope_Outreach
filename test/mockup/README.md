# M@TE website mockup (temporary)

A design mockup for discussion. It is **not** the Model Atlas of the Earth website; the real
site is <https://mate.science/>. This folder is a temporary addition and will be removed once the
discussion is over.

Open `index.html`. A dark bar at the top of every page switches between the options:

- **1 to 4**: four home-page layouts, in AuScope styling, with a choice of footer.
- **5**: a model page with a 3D viewer that runs in the browser. Three pilot models:
  Vulcan (3D inversion), Sunda megathrust (3D Underworld) and oceanic detachment faults
  (2D ASPECT, with time steps).

## Where the content comes from

- Model listing, text and figures for Sunda and Detachment: copied from mate.science on
  20 November 2026.
- Viewer data for Sunda and Detachment: reduced copies made from those models' outputs in the
  M@TE collection at NCI. Viewing copies only, not for computing.
- Vulcan: the Vulcan 2022 Level 3 Model 1 record (DOI 10.25914/arwp-q219), reduced for viewing.
- Logos belong to AuScope, NCRIS and NCI.

`tools/` holds the scripts that made the viewer copies. Each one checks its own output and says
in its header what would make that check fail.

Prepared by Ben Kay.
