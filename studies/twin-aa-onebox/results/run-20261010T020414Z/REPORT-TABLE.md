# Endpoint table — 2026-10-twin-aa-onebox (generated 2026-10-10T02:04:14.671Z)

| Endpoint | Registered | Observed | Verdict |
|---|---|---|---|
| O1 same AZ | ≤ 10 of 100 executable; stop at 11 | 0/100 = 0.000 | PASS |
| O2 across AZs | ≤ 10 of 100 executable; stop at 11 | 0/100 = 0.000 | PASS |
| O3 sample-ratio halts | ≤ 2 of attempted | 0 of 200 | PASS |
| O4 sensitivity count | ≤ 10 per stratum | S 0, X 0 | S PASS, X PASS |

S: attempts 100, executable 100, void 0, W0 rollbacks 0; fired {}; rollbacks none; per lane l0 0/50 ratio 1.002, l1 0/50 ratio 0.999; unmargined share 0.333/0.500/0.633; beyond-margin share 0.000/0.050/0.117; median p99 ms canary 76.4 control 76.3; p99 ratio min/median/max 0.977/1.001/1.024.

X: attempts 100, executable 100, void 0, W0 rollbacks 0; fired {}; rollbacks none; per lane l2 0/50 ratio 1.003, l3 0/50 ratio 0.997; unmargined share 0.300/0.500/0.650; beyond-margin share 0.000/0.050/0.117; median p99 ms canary 76.3 control 76.4; p99 ratio min/median/max 0.975/1.000/1.029.

Rate detector fires 0. Authority violations 0. V10 void runs none. V6/V7 evaluated on 200 of 200; flagged none; unassigned inside 264, 265, 268, 269, 272, 273, 274, 276, 277, 278, 280, 284, 292, 296, 300, 301, 304, 305, 307, 308, 309, 312, 313, 316, 317, 320, 321, 324, 325, 326, 328, 330, 332, 333, 336, 340, 344, 345, 347, 348, 349, 352, 353, 354, 356, 357, 358, 360, 361, 362, 363, 364, 365, 366, 367, 368, 369, 370, 371, 372, 373, 374, 375, 376, 377, 378, 379, 380, 381, 382, 383, 384, 385, 386, 387, 388, 389, 390, 391, 392, 393, 394, 395, 396, 397, 398, 399, 400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 419, 420, 421, 422, 423, 424, 425, 426, 427, 428, 429, 430, 431, 432, 433, 434, 435, 436, 437, 438, 439, 440, 441, 442, 443, 444, 445, 446, 447, 448, 449, 450, 451, 452, 453, 454, 455, 456, 457, 458, 459, 460, 461.
