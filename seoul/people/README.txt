Crowd bodies for Neon Seoul (stream G1, phase 3; phase 6: 14): avatars from the Microsoft Rocketbox Avatar Library
(github.com/microsoft/Microsoft-Rocketbox, MIT licence, (c) 2020 Microsoft; see LICENSE-Rocketbox.md):
Business_Male_01, Male_Adult_03, Male_Adult_04, Male_Adult_18, Business_Female_04, Female_Adult_07, Female_Adult_09, Female_Adult_13,
and (P6, East Asian, people.json `ea`) Business_Male_02, Male_Adult_09, Male_Adult_10, Business_Female_03, Female_Adult_11, Female_Adult_05.
atlas.jpg is 2048 x 4096 (4 x 4 cells of 512 x 1024), hair.png and aux.png 1024 x 1024 (256^2 cells).
Baked by seoul/tools/people-bake.mjs (pose, CPU skin, bone remap onto the crowd rig, meshoptimizer LODs) and
seoul/tools/people-atlas.py (atlas.jpg: body + head maps at 512^2 each; hair.png: hair-card maps at 256^2; class means).
