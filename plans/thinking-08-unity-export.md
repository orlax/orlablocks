## Unity Exporting 


Now that I have the first "real" level designed I want to see how could I send this to unity. 

my current understanding is:

- our project files are JSON with our schema that describes the shapes, where they are, what type 
position, scale, rotation and so on. 
- the web client then draws all of that on real time. And takes care of the CSG steps.
- so we don'r really have any "geometry" data saved anywhere. 

A path to the unity export:

option 1: we could just BAKE everything into a single FBX file with some sort of hierarchy and that's it. I think this would be easy but also the less flexible option.

Option 2: we built a "UnityRenderer" that reads the same file projects we have already and just recreates then on unity. All the primitives should be there and we could just use Probuilder.
- instances become prefabs that get replicated properly
- a fancy thing would be that edits on the web client affect the files and then a "refresh" on unity 
updates our in game blockout. 
- if we had a "mappings" file in our project handled from unity that could inform "this instance is this prefab so we instantiate this prefab here instead" man that would be amazing. 
- then we get into overrides, or having work on unity also affect the files back so that gets reflected on the webclient? (this info back from unity I think is a bit too much)

I like option 2 best, as the flow  I imagine is:

- design on orlablocks get things to 90%
- test on unity actually play the levels, maybe even connect things 
    - it is likely at this stage work just continues on unity 
- but for changes that might be better on orlablocks or if a level just fails and needs redesign the refresh option without having to re-import everything would be good.


