// Curated word list for public handles (Word#1234). Animals + nature only, all
// 3–10 characters, lowercase, no profanity, no spaces — vetted by hand so we never
// surface a dubious or offensive word. Kept server-side because handle generation
// (and its uniqueness check) happens on the server.
//
// Combined with a 4-digit discriminator this gives well over a million unique
// handles, which is plenty for a self-hosted instance.

export const HANDLE_WORDS: readonly string[] = [
  // mammals
  'otter', 'badger', 'beaver', 'bison', 'bobcat', 'camel', 'cheetah', 'cougar',
  'coyote', 'dingo', 'dolphin', 'donkey', 'elephant', 'elk', 'ferret', 'fox',
  'gazelle', 'giraffe', 'goat', 'gopher', 'hamster', 'hare', 'hedgehog', 'horse',
  'hyena', 'ibex', 'jackal', 'jaguar', 'koala', 'lemur', 'leopard', 'lion',
  'llama', 'lynx', 'marmot', 'meerkat', 'mink', 'mole', 'mongoose', 'moose',
  'mouse', 'narwhal', 'ocelot', 'okapi', 'orca', 'panda', 'panther', 'platypus',
  'polecat', 'porpoise', 'possum', 'puma', 'rabbit', 'raccoon', 'ram', 'rat',
  'reindeer', 'rhino', 'seal', 'sheep', 'shrew', 'skunk', 'sloth', 'squirrel',
  'stoat', 'tapir', 'tiger', 'vole', 'walrus', 'weasel', 'whale', 'wolf',
  'wombat', 'yak', 'zebra', 'antelope', 'baboon', 'buffalo', 'caribou', 'chamois',
  'civet', 'chinchilla', 'gerbil', 'gibbon', 'lemming', 'manatee', 'wallaby',
  // birds
  'avocet', 'bittern', 'budgie', 'bunting', 'canary', 'chicken', 'condor', 'crane',
  'crow', 'cuckoo', 'curlew', 'dipper', 'dove', 'duck', 'eagle', 'egret',
  'falcon', 'finch', 'flamingo', 'fulmar', 'gannet', 'goose', 'goshawk', 'grebe',
  'grouse', 'gull', 'harrier', 'hawk', 'heron', 'hoopoe', 'ibis', 'jackdaw',
  'jay', 'kestrel', 'kingbird', 'kite', 'kiwi', 'lapwing', 'lark', 'linnet',
  'macaw', 'magpie', 'mallard', 'martin', 'merlin', 'nuthatch', 'oriole', 'osprey',
  'ostrich', 'owl', 'parrot', 'peacock', 'pelican', 'penguin', 'petrel', 'pheasant',
  'pigeon', 'pintail', 'pipit', 'plover', 'puffin', 'quail', 'raven', 'redshank',
  'robin', 'rook', 'shrike', 'siskin', 'sparrow', 'starling', 'stork', 'swallow',
  'swan', 'swift', 'tanager', 'teal', 'tern', 'thrush', 'tit', 'toucan',
  'turkey', 'vulture', 'wagtail', 'warbler', 'waxwing', 'wigeon', 'woodlark', 'wren',
  // reptiles + amphibians
  'adder', 'agama', 'anole', 'boa', 'caiman', 'chameleon', 'cobra', 'frog',
  'gecko', 'iguana', 'lizard', 'mamba', 'monitor', 'newt', 'python', 'tadpole',
  'salamander', 'skink', 'slowworm', 'snake', 'taipan', 'terrapin', 'toad', 'tortoise', 'turtle',
  'viper', 'tuatara', 'axolotl', 'gharial',
  // fish + sea life
  'anchovy', 'barracuda', 'bass', 'bream', 'carp', 'catfish', 'clam', 'cockle',
  'cod', 'coral', 'crab', 'eel', 'flounder', 'grouper', 'guppy', 'haddock',
  'hake', 'halibut', 'herring', 'koi', 'lamprey', 'limpet', 'lobster', 'mackerel',
  'manta', 'marlin', 'minnow', 'mussel', 'nautilus', 'octopus', 'oyster', 'perch',
  'pike', 'pollock', 'prawn', 'puffer', 'ray', 'salmon', 'sardine', 'scallop',
  'shark', 'shrimp', 'snapper', 'sole', 'sponge', 'squid', 'starfish', 'sturgeon',
  'tetra', 'trout', 'tuna', 'turbot', 'urchin', 'whelk', 'wrasse',
  // insects + small critters
  'ant', 'aphid', 'beetle', 'bumblebee', 'butterfly', 'cicada', 'cricket', 'damsel',
  'dragonfly', 'earwig', 'firefly', 'gnat', 'grub', 'hornet', 'katydid', 'ladybug',
  'locust', 'mantis', 'mayfly', 'midge', 'moth', 'snail', 'termite', 'weevil',
  'centipede', 'scorpion', 'spider', 'tarantula', 'woodlouse',
  // trees + plants
  'alder', 'almond', 'apple', 'ash', 'aspen', 'bamboo', 'baobab', 'beech',
  'birch', 'bracken', 'bramble', 'cactus', 'cedar', 'cherry', 'chestnut', 'clover',
  'conifer', 'cypress', 'elm', 'fern', 'fir', 'gorse', 'hawthorn', 'hazel',
  'heather', 'holly', 'ivy', 'juniper', 'larch', 'laurel', 'lichen', 'linden',
  'mahogany', 'maple', 'mistletoe', 'moss', 'mulberry', 'nettle', 'oak', 'olive',
  'palm', 'pine', 'poplar', 'redwood', 'reed', 'rowan', 'sequoia', 'spruce',
  'sycamore', 'thistle', 'walnut', 'willow', 'yew',
  // flowers + fruit
  'apricot', 'azalea', 'bluebell', 'cosmos', 'crocus', 'daffodil', 'dahlia', 'daisy',
  'fig', 'foxglove', 'iris', 'jasmine', 'lavender', 'lilac', 'lily', 'lotus',
  'magnolia', 'mango', 'marigold', 'mimosa', 'orchid', 'pansy', 'papaya', 'peach',
  'peony', 'plum', 'poppy', 'primrose', 'quince', 'tulip', 'violet', 'zinnia',
  // gems + minerals
  'agate', 'amber', 'amethyst', 'azurite', 'basalt', 'beryl', 'citrine', 'cobalt',
  'copper', 'coralite', 'crystal', 'diamond', 'emerald', 'flint', 'garnet', 'geode',
  'granite', 'jade', 'jasper', 'malachite', 'marble', 'obsidian', 'onyx', 'opal',
  'pearl', 'peridot', 'pyrite', 'quartz', 'ruby', 'sapphire', 'silver', 'slate',
  'topaz', 'sunstone', 'turquoise', 'zircon',
  // weather + sky + terrain
  'aurora', 'blizzard', 'breeze', 'canyon', 'cinder', 'cloud', 'comet', 'crater',
  'delta', 'dew', 'dune', 'ember', 'fjord', 'fog', 'frost', 'galaxy',
  'geyser', 'glacier', 'gorge', 'grotto', 'gully', 'harbor', 'hollow', 'island',
  'lagoon', 'lava', 'meadow', 'mesa', 'meteor', 'mist', 'monsoon', 'moor',
  'nebula', 'oasis', 'pebble', 'plateau', 'prairie', 'rainbow', 'rapids', 'ravine',
  'reef', 'ridge', 'savanna', 'shale', 'shoal', 'sleet', 'spring', 'storm',
  'stream', 'summit', 'sunset', 'thunder', 'tundra', 'valley', 'volcano', 'zephyr',
  // longer (10-char) animals + nature
  'rhinoceros', 'cuttlefish', 'anglerfish', 'coelacanth', 'silverfish', 'woodpecker',
  'kingfisher', 'budgerigar', 'turtledove', 'greenfinch', 'shearwater', 'meadowlark',
  'flycatcher', 'bufflehead', 'wildebeest', 'jackrabbit', 'cottontail', 'timberwolf',
  'eucalyptus', 'blackthorn', 'sandalwood', 'cottonwood', 'snapdragon', 'cornflower',
  'nasturtium', 'gooseberry', 'blackberry', 'tourmaline', 'aquamarine', 'serpentine',
];
