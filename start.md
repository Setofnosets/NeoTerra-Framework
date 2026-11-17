# Neo Terra Framework V1
This is a description for a work in progress SillyTavern extension that implements an entire interconnected universe of characters in the same setting.

## Description
This extention has the intent of servicing exclusively one particular setting and it's characters: The NeoTerra universe. A comic book inspired, femdom themed universe centered around it's titular city where superheroes and villains are a frequent sight. Superheroes step in to save the day, have casual flings and be generally sexy, while villains attempt to take over the city, corrupt/brainwash/rape/etc heroes and still be all around sexy but evil.

### Requirements 
Neo Terra is a universe divided in "seasons" (Currently 4 main seasons, an alternate season and some additional characters and a planned season 5). Each season occurs in chronological order but it a self contained storyline with it's own major characters and events.
- There should be some kind of "entry point" menu that allows the player to select their preffered season (A card for each season or some external script maybe?) in which point the world is constructed according to that season.
    - Optionally, a generic entry point for when a specific storyline is not desired.
    - If not mechanically viable, the player should select a character from a menu that sorts into the seasons and build the world around that with the selected character being the "beginning" of the story.
- The extension should track the selected season and load correct characters, lorebooks, etc.
#### Storyline tracker
- A tracker agent/system that builds the world according to the selected season, afterwards tracks the world state each time location changes/n-number of turns and updates it at a high level. 
- Should track active characters, locations, factions, progress, allegiances, location, goals, and other relevant values
#### Characters
- Relevant characters to the season should be loaded, other characters only manually. 
- Must decide between creating a giant lorebook with every relevant character or hotswapping character cards depending on context.
    - Investigate separate agent that decides which characters to inject from the available characters list (Current season + manually added)
    - Propose other alternatives from these 2
- Each character must be be updated with their current status, agenda, location, stamina, abilities, likes, dislikes, appearance, etc
    - Heroes and villains should have civilian lives, jobs, sleeping, entertainment, etc when not out ther doing hero/villain stuff
    - Skills (Active abilities) and traits (Passives) should be compiled when the caracter is first introduced in the current story and stored.
    - Character appearance, description, abilities, etc. should be dynamic and updated whenever relevant, after story update, etc. For instance, a villain that brainwashes defeated heroes into servants would change their abilities, appearance, motivations, likes & dislikes etc
        - Trackers for such things may be necessary to add a time component
- Current character info for every current character can be consulted at any time from a button on the map
- Plenty of characters have alternative corrupted/brainwashed/etc forms, they should naturally not be present at the same time but those forms should be taken into consideration as to which characters are injected. Chracters that are transformed into their alternative versions should essentially be swapped with the corresponding card.
#### City Map
Current version of the map is NeoTerra.png.
- In the top right of the UI, a button to open the map.
- Displays the current map with functionality to zoom, pan etc.
- Overlays multiple nodes in the map with key locations
    - Selecting a node should open a submenu with location name, description, present characters, current status, etc. And a "travel to" option enabled only while out of combat.
    - Optional setting to modify or add new key locations on the overlay or reset to default
- Travelling should update the story, character locations, location status, etc. And generate a new intro for the location change,  potentially introducing present characters.
- Final overlay at the top that sumarrizes current status: Activa factions and their goals, the main villains influence, latest actions, etc...
    - Optional newspaper-style headlines for recent events
- Current main threat and the progress to fulfilling their agenda
    - Season 4 has 2 main threats so should be able to accomodate multiple factions
#### State tracker
- Main tracker for player state. 
- Modular system that lists stamina, skills, traits, allegiance, status, etc.
    - Effectively the player character info like the Characters section
- Separate agent that only updates the tracker
#### Lore agent
- Main current events/story agent
- It's job is to keep track of recent events, changes, etc and store them into lorebooks or some other storage medium.
- Effectively summarizes recent events, locations, states and generic character information
- Decides what entries to inject into the context
- Tracks character relationships: Who they like/dislike, who they're attracted to, what relationship they have with whom, etc.
#### UI
- Sleek, futuristic
- Custom UI that serves the purpose of implementing the extension
- Lower-ish priority for the time being
#### Other
- Connections, presets, etc could still use standard sillytavern systems
- Combat should not be full on rpg stats-based combat with damage numbers, etc... but still dice-based as adding randomness and some tracking helps reduce model bias -> Better roleplaying
- The theme is inherently explicit with both violent and sexual themes
- Custom prompts for each agent
- Extensive settings
- Map, characters, seasons should be extensible as there will be new characters and seasons, and potentially new locations outside of the main city
### Notes
- The other extensions in the sibling `extensions` directory may serve as a possible reference for some of these systems
- Please make proposals as to other additionas that may be necessary, or could provide interesting gameplay/experiences.
    - Same goes for this proposal and what could change for a better, more robust system.
- The Chars folder contains json files for many of the current characters divided into seasons as well as lorebooks (Characters can also be png files but json is easir to read for AI models and as such this implementation) The Others folder contains a different setting, so it's saved for a second version.
