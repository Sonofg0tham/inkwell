import { describe, expect, it } from 'vitest';
import { findLocalRuleIssues } from '../lib/checker/localRules';
import {
  findLocalSpellingIssues,
  mergeLocalSpellingIssues,
} from '../lib/checker/localSpelling';
import type { IssueDto } from '../lib/messaging/protocol';
import { DEFAULT_SETTINGS, settingsSchema, type Settings } from '../lib/settings/schema';

// The offline pass is what every user gets, with or without a model. These
// cases are the everyday mistakes a mainstream writing assistant catches
// without any AI, so the offline checker must catch them too. Each entry is
// [text, original, replacement].
const MUST_CATCH: ReadonlyArray<readonly [string, string, string]> = [
  // Common misspellings, including at the start of a sentence where the
  // dictionary pass skips capitalised words as likely names.
  ['I definately agree with you.', 'definately', 'definitely'],
  ['We need to accomodate more guests.', 'accomodate', 'accommodate'],
  ['The goverment announced new rules.', 'goverment', 'government'],
  ['Goverment ministers met today.', 'Goverment', 'Government'],
  ['Unfortunatly, the shop was closed.', 'Unfortunatly', 'Unfortunately'],
  ['Untill Friday, the office is shut.', 'Untill', 'Until'],
  ['The begining of the film was slow.', 'begining', 'beginning'],
  ['This is truely amazing.', 'truely', 'truly'],
  ['Recieve the parcel at the door.', 'Recieve', 'Receive'],
  ['Tommorow is another day.', 'Tommorow', 'Tomorrow'],
  ['Thier house is lovely.', 'Thier', 'Their'],
  ['Wich one do you want?', 'Wich', 'Which'],
  ['Alot of people came.', 'Alot', 'A lot'],
  ['Basicly, it works.', 'Basicly', 'Basically'],
  ['Occassionally we eat out.', 'Occassionally', 'Occasionally'],
  ['Neccessary changes were made.', 'Neccessary', 'Necessary'],
  // Missing apostrophes in contractions.
  ['I dont know what happened.', 'dont', "don't"],
  ['Dont forget the milk.', 'Dont', "Don't"],
  ['She doesnt like it.', 'doesnt', "doesn't"],
  ['It isnt ready yet.', 'isnt', "isn't"],
  ['We didnt see it.', 'didnt', "didn't"],
  ['They havent replied.', 'havent', "haven't"],
  ['Thats a good idea.', 'Thats', "That's"],
  ['im not sure about that.', 'im', "I'm"],
  ['Ive finished the report.', 'Ive', "I've"],
  ['Youre right about that.', 'Youre', "You're"],
  ['Theyre coming later.', 'Theyre', "They're"],
  ['I couldnt hear you.', 'couldnt', "couldn't"],
  ['You shouldnt worry.', 'shouldnt', "shouldn't"],
  ['He wasnt there.', 'wasnt', "wasn't"],
  // The pronoun I.
  ['Yesterday i went home.', 'i', 'I'],
  ['i think so too.', 'i', 'I'],
  ["I hope i'm not late.", "i'm", "I'm"],
  ["Tell me if i've missed anything.", "i've", "I've"],
  // Repeated words.
  ['The the dog barked.', 'The the', 'The'],
  ['We went to the the shop.', 'the the', 'the'],
  ['Could you send me the file file?', 'file file', 'file'],
  ['It is is broken.', 'is is', 'is'],
  // it's and its.
  ['Its been a long day.', 'Its', "It's"],
  ['Its a lovely morning.', 'Its', "It's"],
  ['I think its going to rain.', 'its', "it's"],
  ['The company changed it\'s name.', "it's", 'its'],
  ['Each team has it\'s own coach.', "it's", 'its'],
  // a and an.
  ['She bought a apple.', 'a', 'an'],
  ['It was a interesting talk.', 'a', 'an'],
  ['He is a honest man.', 'a', 'an'],
  ['We waited a hour.', 'a', 'an'],
  ['That was an mistake.', 'an', 'a'],
  ['She is an teacher.', 'an', 'a'],
  ['It is an unique chance.', 'an', 'a'],
  ['He studies at an university.', 'an', 'a'],
  // Modal + of, there/their/they're, your/you're.
  ['I should of known.', 'of', 'have'],
  ['You would of liked it.', 'of', 'have'],
  ['Their is a problem.', 'Their', 'There'],
  ['Your welcome to join us.', 'Your', "You're"],
  ['I think your going to love it.', 'your', "you're"],
  ['Your not allowed in there.', 'Your', "You're"],
  // Agreement that never depends on meaning.
  ['She dont like it.', 'dont', "doesn't"],
  ["He don't care.", "don't", "doesn't"],
  ['They was late again.', 'was', 'were'],
  ['We was going to call.', 'was', 'were'],
  ["They doesn't know.", "doesn't", "don't"],
  // Comparisons and common confusions.
  ['He is taller then me.', 'then', 'than'],
  ['This is better then before.', 'then', 'than'],
  ['I would rather walk then drive.', 'then', 'than'],
  ['We could loose the match.', 'loose', 'lose'],
  ['Try not to loose your keys.', 'loose', 'lose'],
  ['The side affects were mild.', 'affects', 'effects'],
  ['It had a big affect on me.', 'affect', 'effect'],
  ['Lets go to the park.', 'Lets', "Let's"],
  ['Your the best.', 'Your', "You're"],
  ['Your a star.', 'Your', "You're"],
  ['Their going to be late.', 'Their', "They're"],
  ['Could you borrow me a pen?', 'borrow', 'lend'],
  ['She borrowed him her car.', 'borrowed', 'lent'],
  ['He is more smarter than me.', 'more smarter', 'smarter'],
  ['This one is more better.', 'more better', 'better'],
  ['She is the most smartest person here.', 'most smartest', 'smartest'],
  ['He has less friends than her.', 'less', 'fewer'],
  ['Me and him was going to the shop.', 'Me and him', 'He and I'],
  ['Me and him was going to the shop.', 'was', 'were'],
  ['Me and Sam went to town.', 'Me and Sam', 'Sam and I'],
  ['Him and me are friends.', 'Him and me', 'He and I'],
  // Spacing and capitalisation.
  ['This is a test.It works.', 'test.It', 'test. It'],
  ['Hello , world.', ' ,', ','],
  ['It was a long  day.', '  ', ' '],
  ['We arrived late. the shop had closed.', 'the', 'The'],
  ['Is it ready? yes, it is.', 'yes', 'Yes'],
];

// Correct writing, including near misses for every rule above. The offline
// checker runs on every keystroke pause, so a false alarm here costs trust.
const MUST_STAY_CLEAN: readonly string[] = [
  'The dog chased its own tail.',
  'Its tail wagged when we came home.',
  'Every team has its strengths.',
  "It's been a long day.",
  "It's a lovely morning.",
  'Their car is red and their house is blue.',
  'There is a problem with the car.',
  "They're coming later.",
  'It took an hour to get there.',
  'He is an honest man.',
  'She works for an MP in London.',
  'Read the FAQ before you ask an FAQ question.',
  'He studies at a university in Leeds.',
  'It was a one-off event.',
  'Once upon a time there was a European city.',
  'She opened an umbrella and walked to a useful shop.',
  'It was an unusual day for a user of the service.',
  'An X-ray showed a fracture.',
  'We were happier then.',
  'I had a cup of tea then left.',
  'Finish your homework, and then we can go.',
  "Let's go to the park.",
  'He lets me drive his car.',
  'The film affects me deeply.',
  'The effect was immediate.',
  'She said that that was fine.',
  'What it is is a mystery.',
  'They had had enough by then.',
  'Mr. Smith arrived at 5 p.m. today.',
  'Bring snacks, e.g. crisps or fruit.',
  'See Fig. three for details.',
  'Wait... what happened next?',
  'The knot came loose in the wind.',
  'The dogs were let loose in the field.',
  'He did not know what to do.',
  "She doesn't like it and they don't either.",
  'They were late again.',
  'Your welcome pack is in the post.',
  'Your going-away party was great.',
  "You're welcome to join us.",
  'I should have known.',
  'Most of the time we walk.',
  'Visit https://example.test/the/the/page for details.',
  'Email me at hello@example.test today.',
  'Keep `it is is` as written in the code sample.',
  'Use node.js and the Array.from() helper.',
  'A cat sat. A dog barked.',
  'I think so too.',
  'Craig went home early.',
  'Windsor Castle is open today.',
  'I hope I am not late.',
  'Bye bye for now.',
  'It was a very, very long day.',
  'Is it ready? Yes, it is.',
  'He bought apples, pears, etc. and then left.',
  'Use version 2.0 of the tool.',
  'The U.K. and the U.S. signed it.',
  "The cat's toy is under the sofa.",
  'The Imam spoke at the event.',
  'A long line of people waited.',
  'Done.\nDone.',
  "You're the best.",
  'Your team is great.',
  'Is this your A-level result?',
  'Their going-away party was fun.',
  'Can I borrow your pen?',
  'Can I borrow you for a minute?',
  'We need more older volunteers.',
  'There are more better-paid jobs now.',
  'Fewer people came than we expected.',
  'I want less sugar in my tea.',
  'It was more or less people like us.',
  'She gave me and him a lift.',
  'Tell me and him later.',
  'Sam and I went to town.',
];

function localIssues(text: string, settings: Settings = DEFAULT_SETTINGS): IssueDto[] {
  // Same order as CheckService: context-aware rules win over plain spelling.
  return mergeLocalSpellingIssues(
    findLocalRuleIssues(text, settings),
    findLocalSpellingIssues(text, settings),
  );
}

describe('offline checker corpus', () => {
  it.each(MUST_CATCH)('catches %j', (text, original, replacement) => {
    const issues = localIssues(text);
    expect(
      issues.map((issue) => ({ original: issue.original, replacement: issue.replacement })),
    ).toContainEqual({ original, replacement });
  });

  it.each(MUST_STAY_CLEAN)('leaves %j alone', (text) => {
    expect(localIssues(text).map((issue) => issue.original)).toEqual([]);
  });

  it('keeps every new rule behind its category switch', () => {
    const settings = settingsSchema.parse({
      categories: { spelling: false, grammar: false, punctuation: false, style: false },
    });
    for (const [text] of MUST_CATCH) {
      expect(localIssues(text, settings)).toEqual([]);
    }
  });
});
