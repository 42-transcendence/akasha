export type Rating = {
  // Skill Rating
  sr: number;
  // Rating Deviation
  rd: number;
  // Rating Volatility
  rv: number;
};

export type OpponentRating = {
  // Skill Rating
  sr: number;
  // Rating Deviation
  rd: number;
  // Outcome
  s: number;
};

export const DEFAULT_SKILL_RATING = 2000;

export const MAX_RATING_DEVIATION_HISTORY_LIMIT = 10;
export const FIXED_POINT_RATIO = 10e6;

const RATING_PERIOD_UNIT = 24 * 60 * 60 * 1000;

export const MAX_RATING_DEVIATION = 350;
const TYPICAL_RATING_DEVIATION = 50;
const RATING_DEVIATION_RETURN_PERIOD = 100;

export const INITIAL_RATING_VOLATILITY = 0.06;

const c = Math.sqrt(
  (MAX_RATING_DEVIATION ** 2 - TYPICAL_RATING_DEVIATION ** 2) /
    RATING_DEVIATION_RETURN_PERIOD,
);

export function calcRatingDeviation(
  initialValue: number,
  dates: Date[],
): number {
  if (dates.length === 0) {
    return MAX_RATING_DEVIATION;
  }

  const [lastDate] = dates;
  const t = (Date.now() - lastDate.valueOf()) / RATING_PERIOD_UNIT;
  return Math.min(
    Math.sqrt(initialValue ** 2 + c ** 2 * t),
    MAX_RATING_DEVIATION,
  );
}

export function calcWinProb(sr: number, sr_i: number, rd_i: number): number {
  return 1 / (1 + Math.exp(-g(rd_i) * (sr - sr_i)));
}

function g(rd: number): number {
  return 1 / Math.sqrt(1 + (3 / Math.PI ** 2) * rd ** 2);
}

const tau = 0.2; // [0.3, 1.2]

export function apply(rating: Rating, opponents: OpponentRating[]): Rating {
  const [deltaNumerator, deltaDenominator] = opponents.reduce(
    ([prevSumA, prevSumB], i) => {
      const G = g(i.rd);
      const E = calcWinProb(rating.sr, i.sr, i.rd);
      const valueA = G * (i.s - E);
      const valueB = G ** 2 * E * (1 - E);
      return [prevSumA + valueA, prevSumB + valueB];
    },
    [0, 0],
  );

  const calcRatingVolatility = (rating: Rating) => {
    // Regula falsi (The Illinois algorithm)
    const a = Math.log(rating.rv ** 2);
    const phi = rating.rd;
    const delta = deltaNumerator / deltaDenominator;
    const v = 1 / deltaDenominator;
    const f = (x: number) =>
      (Math.exp(x) * (delta ** 2 - phi ** 2 - v - Math.exp(x))) /
        (2 * (phi ** 2 + v + Math.exp(x)) ** 2) -
      (x - a) / tau ** 2;
    const epsilon = 1e-6;

    let x1 = a;
    let x2: typeof x1;
    if (delta ** 2 > phi ** 2 + v) {
      x2 = Math.log(delta ** 2 - phi ** 2 - v);
    } else {
      for (let k = 1; f((x2 = a - k * tau)) < 0; k++);
    }

    let y1 = f(x1);
    let y2 = f(x2);
    while (Math.abs(x2 - x1) > epsilon) {
      const x_prime = x1 + ((x1 - x2) * y1) / (y2 - y1);
      const y_prime = f(x_prime);
      if (y_prime * y2 <= 0) {
        x1 = x2;
        y1 = y2;
      } else {
        y1 = y1 / 2;
      }
      x2 = x_prime;
      y2 = y_prime;
    }

    return x1;
  };

  const rv = Math.exp(calcRatingVolatility(rating) / 2);
  const rd = 1 / Math.sqrt(1 / (rating.rd ** 2 + rv ** 2) + deltaDenominator);
  const sr = rating.sr + rd ** 2 * deltaNumerator;
  return { sr, rd, rv };
}
