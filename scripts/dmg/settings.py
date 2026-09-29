# The DMG window, for dmgbuild 1.6.7 (https://github.com/dmgbuild/dmgbuild), which publish-local-update.sh runs through uvx.
# dmgbuild writes Finder's layout into the image itself, so nothing has to script Finder.
#
# background.tiff is the brand pack's product/installer-background-660x400.png and its @2x, joined with
#   tiffutil -cathidpicheck installer-background-660x400.png installer-background-660x400@2x.png -out background.tiff
# The icons sit in its two clearings, at the positions below.
import os.path

app = defines["app"]
files = [app]
symlinks = {"Applications": "/Applications"}
format = "UDZO"
background = defines["background"]
window_rect = ((200, 120), (660, 400))
default_view = "icon-view"
icon_size = 128
text_size = 12
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
icon_locations = {os.path.basename(app): (180, 190), "Applications": (480, 190)}
