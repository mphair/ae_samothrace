# Desk import of Interactive Map: Sanctuary of the Great Gods, Samothrace; for Ars Magica saga cartography

This is a fork of <https://github.com/jagingrich/samo_website> (see note below),
for the purpose of ingesting the data into Desk <https://github.com/inadvisable-adventures/desk>
to use as a basis for cartography in an [Ars Magica](https://en.wikipedia.org/wiki/Ars_Magica) saga.


## Forked from Interactive Map: Sanctuary of the Great Gods, Samothrace

Code, text, images, and GIS files that support this interactive map: Jared Gingrich, October 18, 2023

This repository contains the text and images (.txt and .jpg files) that are read by the web map to load the descriptions that accompany each monument on the plan. Updating or replacing the files in the monument directories found in the Data tree of this repository will update the descriptions of the web map. Adding additional monument directories, named with a unique numeric identifier that matches with a feature on the GIS layers (found in the mapFeatures directory) will add a new description. 

InteractiveSanctuaryPlan.html is the most up-to-date version of the code for the interactive web map. It uses the variable settings and functions in the InteractiveSanctuaryPlan.js file and the webpage formatting in the InteractiveSanctuaryPlan.css file. 

**File Upload and Naming Notes:**
* Text description files should be a .txt file, ideally with UTF-8 encoding
* Image files should be in .jpg format
* Image files should all have the same name with a sequential image tag ("Image1", Image2", etc.) that corresponds to the order in which they will be displayed
* The number of image files should correspond to the number of captions in the text description file:
  * If there are fewer captions than images in the monument directory, not all images will be displayed
  * If there are more captions than images in the monument directory, the additional captions will not have images attached
