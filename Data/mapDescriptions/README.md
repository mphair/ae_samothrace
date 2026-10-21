# Monument descriptions — Samothrace sanctuary

Per-monument description text and inline figure images, one directory
per numbered/lettered monument (the same id used on the GIS layers in
`Data/mapFeatures/`), plus `SamoWebsite_mapDescriptions_Index.csv` (the
id → display-label lookup). Each monument directory holds a
`SamoWebsite_<webCode>.txt` file in a plain-text, line-tagged
convention — see
`desk_widgets/samothrace-description/samothrace-description.ts`'s own
header comment for the exact format that widget parses — plus zero or
more `SamoWebsite_<webCode>_Image<n>.jpg` figures referenced from it.

## Provenance

This project is a fork of
[jagingrich/samo_website](https://github.com/jagingrich/samo_website)
— **American Excavations: Samothrace**'s own "Interactive Map:
Sanctuary of the Great Gods, Samothrace" web map (see root
`README.md`'s own "Forked from..." section for the full note). This
directory's text and images are that project's own scholarly content
— written by, and about, American Excavations: Samothrace's work —
carried over unmodified at import time; nothing in this project edits
or re-authors it, only parses and displays it.

Read live by `desk_widgets/samothrace-description/` (the "Samothrace
Monument Description" widget), which credits this same source directly
in its own footer.
