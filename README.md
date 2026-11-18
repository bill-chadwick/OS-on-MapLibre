# OS-on-MapLibre

Here you will find ways to display leisure map tiles (1:50K and 1:25K) from Ordnance Survey using MapLibre.

os27700MapLibre.htm displays the map tiles in their native EPSG:27700 (British National Grid) projection. The grid shown on the map will be straight up on the map display.

warp_os_example.htm uses warped_os_maplibre.js to reproject EPSG27700 tiles to EPSG:3857 (Web Mercator), in the browser. This will be useful if you want to compose with other EPSG:3857 map layers. The grid shown on the map will be rotated.

warp_os_3d_example.htm drapes OS 50K mapping over 3d terrain from https://mapterhorn.com/


Get your OS Maps API keys from here https://osdatahub.os.uk/
