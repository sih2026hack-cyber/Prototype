// The prompt Muse Spark answers for each video clip.
export const VIDEO_PROMPT = `You review a short video someone is about to post on social media. Watch all of it, frames and sound. Answer two questions honestly and carefully.

1. Does it show signs of being generated or heavily altered by AI?
Look for concrete mistakes AI video makes: objects or people morphing, melting or popping in and out between frames; hands and fingers changing; text and signs that change or turn to squiggles from frame to frame; faces that drift or flicker; physics that is impossible (water, cloth, hair moving wrongly); lip movement that doesn't match the speech.
Also look for visible AI marks stamped on the video (Meta's "Imagined with AI" or "AI info" label, Snapchat's ghost-with-sparkles watermark, Gemini's sparkle, Sora's or Veo's watermark, an "AI generated" sticker or caption): a clear mark is a strong sign. Coming from Snapchat, Instagram or a screen recording is NOT a sign by itself.
Ask whether what happens could actually happen: sizes next to people, weight and support, physics (gravity, water, cloth, hair), cause and effect. An impossible event is a strong sign; unlikely but possible is not.
Report filters and edits separately in "edits": colour filter, beauty filter, AR lens (ears, glasses drawn on), stickers or text. An ordinary filter is NOT AI generation. An AI lens that redraws the whole person or scene IS: then also answer "likely_ai". When a beauty filter is evident, smooth skin alone is not a sign.
- "likely_ai": you found at least one such mistake or mark. Every sign you list must be one, with the time it happens.
- "no_ai_signs": you looked carefully and found none. This does NOT mean the video is real; never list reasons it "looks real".
- "cant_tell": too short, blurry, dark or compressed to inspect.

2. Is it harmful to post?
Harmful = graphic violence, sexual content, hate symbols or slurs (seen or spoken), threats, doxxing (private details visible or spoken: home address, phone number, ID card, bank card, shipping label with a name), encouraging self-harm, or a realistic fake of a real, identifiable person in a damaging situation.
When it is harmful and hiding certain objects would make the rest fine, list them in "harm.hide": each as one or two plain words naming the visible OBJECT that carries the detail ("label", "ID card", "sign", "screen"), at most 3. An object detector reads these literally, so name the object, not what is written on it. If hiding objects can't make it fine, give none.

Separately, in "privacy", list small identifying details in an otherwise fine video that are kindest to blur: a readable car number plate, a house or flat number, a stranger's name badge, a phone screen showing messages. These do NOT make the video harmful. Same naming rule as "hide" ("license plate", "house number", "badge"), at most 3; usually none.

Return ONLY this JSON, on one line:
{"verdict": "likely_ai" | "no_ai_signs" | "cant_tell", "confidence": <0.0–1.0>, "summary": "<one plain sentence describing the video for a viewer>", "edits": [{"type": "color_filter" | "beauty_filter" | "ar_lens" | "ai_lens" | "stickers_or_text", "what": "<a few plain words>"}], "signs": [{"at": <seconds>, "what": "...", "why": "<one plain sentence>"}], "harm": {"harmful": <true|false>, "category": "none" | "violence" | "sexual" | "hate" | "threat" | "doxxing" | "self_harm" | "deceptive_fake", "reason": "<one plain sentence, or empty>", "hide": ["<noun phrase>", ...]}, "privacy": ["<noun phrase>", ...]}`;

// The prompt Muse Spark answers for each image. Edit here; re-run the test images after any change.

export const ASSESS_PROMPT = `You review an image posted on social media. Answer two questions about it, honestly and carefully.

1. Does it show signs of being generated or heavily altered by AI?
Look hard for concrete mistakes AI image generators make: malformed or extra fingers, teeth or ears; garbled, misspelled or nonsensical text and signs; impossible reflections or shadows; warped straight lines, railings or tiles; objects melting or merging into each other; repeated or duplicated faces and patterns; jewellery, glasses or clothing that doesn't connect; physically impossible structures; an unnaturally perfect, airbrushed look.
- "likely_ai": you found at least one concrete sign like those. Every sign you list must be such a mistake.
- "no_ai_signs": you looked carefully and found none. Modern AI images can look perfectly real, so this does NOT mean the image is real. Never list reasons an image "looks real"; for this answer, "signs" is empty.
- "cant_tell": the image is too small, blurry, compressed, cropped or stylised to inspect properly.
- Illustrations, cartoons and memes are not "fake photos": judge whether AI made them, but say plainly that they are not presented as photos.

2. Is it harmful to post?
Harmful = graphic violence or gore, sexual content, hate symbols or slurs (including text in the image), threats, doxxing (visible private details such as addresses, phone numbers, ID cards, bank cards, boarding passes), encouraging self-harm, or a realistic fake of a real, identifiable person in a damaging situation. Ordinary photos, opinions and jokes are not harmful.
When it is harmful, list in "harm.regions" each part that would have to be hidden for the rest of the image to be fine to post: each phone number, address, ID card, number plate, slur or hate symbol, gory wound. Box each one tightly (same 0–1000 grid as below), at most 6, and name it plainly ("phone number", "home address", "ID card"). A person's name shown with their address or phone number is part of the private detail: box it too.
Separately, in "privacy", list small identifying details in an otherwise fine image that are kindest to blur: a readable car number plate, a house or flat number, a stranger's name badge, a phone screen showing messages. These do NOT make the image harmful (leave "harmful" false for them). Box each tightly, at most 4; usually none. For text, box the WHOLE block: every line from its first letter to its last character, including postcodes and numbers at the ends of lines. A box that is too big is fine; one that leaves part of an address readable is not. If hiding parts cannot make it fine (the whole image is the problem), return no regions.

Look for visible AI marks stamped on the image itself (they survive screenshots): Meta's "Imagined with AI" label or "AI info" tag, Snapchat's small ghost-with-sparkles watermark on images made with its AI tools, Google Gemini's sparkle mark, DALL·E's row of coloured squares, an "AI generated" caption or sticker, or an app screen showing the image came from an AI feature (an AI lens or "Dreams" name). A clear AI mark is a strong sign: list it and box the mark. Coming from Snapchat, Instagram or a screenshot is NOT a sign by itself: most snaps are real photos with filters.

Beauty filters (common on Snapchat and Instagram) smooth skin on real photos. When a filter is evident, smooth or airbrushed skin alone is not a sign; it counts only alongside a stronger one (a malformed hand, broken text, an impossible scene, an AI mark).

Report filters and edits separately in "edits": a colour filter (rainbow, vintage, black and white), a beauty filter (smoothed skin, slimmed face), an AR lens (dog ears, glasses, face paint drawn on), stickers, text or captions added in an app. An ordinary filter or lens is NOT AI generation, and the viewer should be told that. But an AI lens that redraws the whole person or scene (Snapchat's AI lenses, "Dreams", "turn me into an anime" style effects) IS AI: then also answer "likely_ai" and list it as a sign.

Then ask whether the scene could actually happen, the way a sharp person would:
- Size: is every object the right size next to the people and things around it? (An adult sitting on a small toy, a cat as big as a car, a hand bigger than a head.)
- Weight and support: could what's shown hold up? (A person resting their full weight on something that would crush, bend or tip over; objects floating with nothing under them.)
- Physics: do light, shadows, reflections, water, smoke and gravity behave consistently?
- Context: is it an impossible or absurd situation presented as an ordinary candid photo?
An impossible scene is a strong sign: list it, explain in plain words why it can't happen, and box the parts involved. Something unlikely but possible (a big inflatable, a staged joke, a costume) is not a sign. Clearly edited jokes or memes that don't pretend to be real photos still count: say they're edited.

Look closely before you answer. Read every piece of text in the image word by word (headlines, signs, labels, small print) and check it: real text is consistent and meaningful; AI text repeats phrases or numbers, contradicts itself, has misspellings, or dissolves into letter-like squiggles. Check every hand (count the fingers, work out whose arm is whose) and every face in a crowd.

Point to the evidence. For each AI mistake you found, give:
- "what": a short noun phrase naming the object or area, the way you would label it ("left hand", "shop sign", "background crowd"),
- "why": one plain sentence a non-expert understands,
- "box": [x1, y1, x2, y2] on a 0–1000 grid ((0,0) top-left, (1000,1000) bottom-right), tight around that area.
Give at most 4 signs, strongest first. Never invent a sign you cannot see.

Return ONLY this JSON, on one line:
{"verdict": "likely_ai" | "no_ai_signs" | "cant_tell", "confidence": <0.0–1.0>, "kind": "photo" | "illustration" | "screenshot" | "meme" | "other", "summary": "<one plain sentence for a viewer>", "edits": [{"type": "color_filter" | "beauty_filter" | "ar_lens" | "ai_lens" | "stickers_or_text", "what": "<a few plain words, e.g. 'rainbow colour filter'>"}], "signs": [{"what": "...", "why": "...", "box": [x1, y1, x2, y2]}], "harm": {"harmful": <true|false>, "category": "none" | "violence" | "sexual" | "hate" | "threat" | "doxxing" | "self_harm" | "deceptive_fake", "reason": "<one plain sentence, or empty>", "regions": [{"what": "...", "box": [x1, y1, x2, y2]}]}, "privacy": [{"what": "...", "box": [x1, y1, x2, y2]}]}`;

// The second, slower look, only for images the first answer found no AI signs in. Clean AI photos
// hide their mistakes where people don't look: arms that belong to nobody, ropes tied to nothing,
// ripples with no cause, labels with counting-digit phone numbers.
export const SECOND_LOOK_PROMPT = `A first look at this image found no obvious AI mistakes. Take a slower, forensic second look: modern AI photos hide their mistakes in places people don't check. Work through every step below, looking at the image itself, before you answer.

1. Bodies. For each person, count their arms and hands and follow each arm from the shoulder to the hand. Is any arm or hand left over, missing, or attached to nobody? In a selfie, who holds the camera? Only one or two arms can be reaching toward it, and each must belong to someone. Check fingers, fingernails, ears, earrings (do both match?), teeth (a uniform white strip instead of separate teeth?) and where hair meets skin.
2. Contact and attachment. Where things touch (fingers wrapped round a cup or handle: count them and check which hand each belongs to; a hand on a shoulder; a rope or cable tied to something, a label stuck on a box, a person on a chair), do they really connect? Ropes and cables must start and end somewhere real; a label on a box must follow the box's surface and edges; tape must wrap the way tape does.
3. Reflections, shadows and cause. Does each reflection in water, glass or metal match the object above it (same shape, same position, right side), and does every object over water have one? Do shadows fall the same way for everything, toward the side away from the light, and is the sun or lamp where the light says it is? Ripples, splashes, steam and mist need a cause: rings spreading around a still object, or light coming from two directions, are signs.
4. Text and printing. Read every word, in every script, including the small and distant signs, posters and bags in the background: that is where AI text breaks first. A sign that repeats the same word, a line that turns into letter-like squiggles part way through, or a word that is almost but not quite a real word is a sign; text that is merely too small or blurry to read is not. Real labels, signs and packaging have a real company or brand, real-looking codes and small print with uneven wear. Generic text ("EXPRESS DELIVERY" with no company), perfectly crisp lines on a worn object, or codes that are just counting digits are signs.
5. Background. Look at the edges and the blurred background: objects that dissolve, merge, repeat, or make no sense (half a chair, a window that bends, a tree growing out of a roof).
6. Geometry. Planks, tiles, railings, table edges, door frames: straight, evenly spaced, and lined up where they should be?

Only list what you can actually point to in this image. The overall look (golden light, perfect smiles, beautiful scenery, shallow focus) is NOT a sign by itself: professional and phone photos look like that too. Real photos have flaws of their own (noise, blur, odd framing): those are not AI signs.

- "likely_ai": you found at least one concrete mistake from the steps above.
- "no_ai_signs": after all six steps you found none.

Return ONLY this JSON, on one line:
{"verdict": "likely_ai" | "no_ai_signs", "confidence": <0.0–1.0>, "summary": "<one plain sentence for a viewer: what the image shows and, if you found signs, the main one>", "signs": [{"what": "<short noun phrase naming the area>", "why": "<one plain sentence>", "box": [x1, y1, x2, y2]}]}
Boxes are on a 0–1000 grid, (0,0) top-left. At most 4 signs, strongest first. Never invent a sign you cannot see.`;
