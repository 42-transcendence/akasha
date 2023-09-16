export type Rating = {
  // Skill Rating
  sr: number;
  // Rating Deviation
  rd: number;
};

export const MAX_RATING_DEVIATION_HISTORY_LIMIT = 10;

const MAX_RATING_DEVIATION = 350;
const TYPICAL_RATING_DEVIATION = 50;
const RATING_DEVIATION_RETURN_PERIOD = 100;

const RATING_PERIOD_UNIT = 24 * 60 * 60 * 1000;

const c = Math.sqrt(
  (MAX_RATING_DEVIATION ** 2 - TYPICAL_RATING_DEVIATION ** 2) /
    RATING_DEVIATION_RETURN_PERIOD,
);

const q = Math.LN10 / 400;

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
    (initialValue ** 2 + c ** 2 * t) ** (1 / 2),
    MAX_RATING_DEVIATION,
  );
}

function g(rd: number): number {
  return 1 / Math.sqrt(1 + 3 * ((q * rd) / Math.PI) ** 2);
}

export function calcWinProb(sr: number, sr_i: number, rd_i: number): number {
  const e = -(g(rd_i) * (sr - sr_i)) / 400;
  return 1 / (1 + 10 ** e);
}

function dSquare(sr: number, opponents: Rating[]): number {
  const sum = opponents.reduce((prevSum, i) => {
    const E = calcWinProb(sr, i.sr, i.rd);
    return prevSum + g(i.rd) ** 2 * E * (1 - E);
  }, 0);
  return 1 / (q ** 2 * sum);
}

export function apply(
  rating: Rating,
  opponents: Rating[],
  outcome: number,
): Rating {
  const sum = opponents.reduce((prevSum, i) => {
    const E = calcWinProb(sr, i.sr, i.rd);
    return prevSum + g(i.rd) * (outcome - E);
  }, 0);
  const dSquareInverse = 1 / dSquare(rating.sr, opponents);
  const rdSquare = 1 / (1 / rating.rd ** 2 + dSquareInverse);
  const sr = rating.sr + q * rdSquare * sum;
  const rd = Math.sqrt(rdSquare);
  return { sr, rd };
}
