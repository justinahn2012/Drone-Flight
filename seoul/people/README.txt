Crowd bodies for Neon Seoul (stream G1, phase 3; phase 6: 14; phase 8: 22; phase 9: 22, 8 East Asian faces on casual bodies): avatars from the Microsoft Rocketbox Avatar Library
(github.com/microsoft/Microsoft-Rocketbox, MIT licence, (c) 2020 Microsoft; see LICENSE-Rocketbox.md):
Business_Male_01, Male_Adult_03, Male_Adult_04, Male_Adult_18, Business_Female_04, Female_Adult_07, Female_Adult_09, Female_Adult_13,
and (P6, East Asian, people.json `ea`) Male_Adult_09, Male_Adult_10, Female_Adult_11, Female_Adult_05 (P9: the suits Business_Male_02 and
Business_Female_03 became the clothes of Male_Adult_20 and Female_Adult_15 under those two heads, in the same slots),
and (P8, East Asian, made from two library avatars: people.json `body` + `head`) the clothes, hands and shoes of Male_Adult_02, Male_Adult_07,
Male_Adult_17, Male_Adult_06, Female_Adult_14, Female_Adult_04, Female_Adult_01, Female_Adult_02 with the head, neck and hair of
Male_Adult_09, Male_Adult_09, Male_Adult_10, Male_Adult_09, Sports_Female_02, Medical_Female_01, Female_Adult_11, Female_Adult_05.
Every avatar also carries a cap, a beanie, a backpack and a tote bag (built in the bake, shown per person by the shader).
atlas.jpg is 1536 x 4608 (4 x 6 cells of 384 x 768: body map over head map), hair.png 1024 x 1536 and aux.png 1024 x 1536 (256^2 cells).
Baked by seoul/tools/people-bake.mjs (pose, CPU skin, bone remap onto the crowd rig, accessories, meshoptimizer LODs),
seoul/tools/people-atlas.py (atlas.jpg, hair.png, class means) and seoul/tools/people-aux.py (aux.png: scalp hair and mask).
