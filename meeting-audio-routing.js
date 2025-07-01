/********************************************************
 * 
 * Author:              William Mills
 *                    	Solutions Engineer
 *                    	wimills@cisco.com
 *                    	Cisco Systems
 * 
 * 
 * Version: 1-0-0
 * Released: 06/01/25
 * 
 * This is an example macro which routes incoming Remote Audio
 * Inputs from a Webex Meeting out specific Audio outputs when
 * joined from a Cisco Collab Device.
 * 
 * The the routing is based on the Remote Audio Role name in the
 * meeting of which the following are available:
 * - "Main": The active speakers in a meeting
 * - "Presentation": The receiving presentations audio
 * - "SimultaneousInterpreter": The audio of the Simultaneous Interpreter
 * 
 * Full Readme, source code and license details for this macro 
 * are available GitHub:
 * https://github.com/wxsd-sales/meeting-audio-routing-macro
 * 
 ********************************************************/



import xapi from 'xapi';

/*********************************************************
 * Configure the settings below
**********************************************************/

const remoteAudioMap = {
  "Presentation": {
    "Loudspeaker": -30,
    "Content Share": 0,
    "Interpreter1": -30
  },
  "SimultaneousInterpreter": {
    "Loudspeaker": -30,
    "Content Share": -30,
    "Interpreter1": 0
  }
}


/*********************************************************
 * Do not change below
**********************************************************/

let timer;


xapi.Status.Audio.Input.RemoteInput.on(({ CallId, Role, id }) => {
  console.log('Audio Remote Input:', CallId, Role, id)
  if (!CallId && !Role) return

  // Simple debounce to trigger gain update as new inputs are added
  clearTimeout(timer);
  timer = setTimeout(updateInputLoudspearkGain, 500);
});

// Perform initial audio check
setTimeout(updateInputLoudspearkGain, 2000);




// Updates the Input Gain for the last Remote Input to the Loudspeaker Output Group
async function updateInputLoudspearkGain() {
  const remoteInputs = await xapi.Status.Audio.Input.RemoteInput.get();
  remoteInputs.forEach(({ Role, id }) => {
    const gains = remoteAudioMap?.[Role];
    if (gains) updateInputGains(Role, id, gains)
  })

}


async function updateInputGains(role, InputId, gains) {
  for (const [outputGroupName, InputGain] of Object.entries(gains)) {
    const OutputId = await getOutputIdGroupByName(outputGroupName);
    console.log(`Updating Input Gain Connection | Role: "${role}" - OutputGroupName: "${outputGroupName}" - OutputId: ${OutputId} - InputId: ${InputId} - InputGain: ${InputGain}`)
    xapi.Command.Audio.LocalOutput.UpdateInputGain({ InputGain, OutputId, InputId })
  }
}


// Get the LocalOutput id for the matching output group name
async function getOutputIdGroupByName(groupName) {
  const localOutputs = await xapi.Status.Audio.Output.LocalOutput.get();
  const loudspeakerOutput = localOutputs.find(output => output.Name.toLocaleLowerCase() == groupName.toLocaleLowerCase())
  return loudspeakerOutput?.id
}
