/********************************************************
 * 
 * Author:              William Mills
 *                    	Solutions Engineer
 *                    	wimills@cisco.com
 *                    	Cisco Systems
 * 
 * 
 * Version: 2-0-0
 * Released: 09/08/25
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
 * https://github.com/wxsd-sales/meeting-audio-macro
 * 
 ********************************************************/



import xapi from 'xapi';

/*********************************************************
 * Configure the settings below
**********************************************************/

const audioConfig = [
  {
    role: "Main",
    outputs: [{
      name: "Loudspeaker",
      gain: 0
    }]
  },
  {
    role: "Presentation",
    outputs: [{
      name: "Content Share",
      gain: 0
    },
    {
      name: "Loudspeaker",
      gain: -30
    }]
  },
  {
    role: "SimultaneousInterpreter",
    languageName: 'es',
    mixerLevel: 50,
    output: "Language 1"

  },
  {
    role: "SimultaneousInterpreter",
    languageName: 'de',
    mixerLevel: 100,
    output: "Language 2"
  },
  {
    role: "SimultaneousInterpreter",
    languageName: 'fr',
    mixerLevel: 50,
    output: "Language 3"
  },
  {
    role: "SimultaneousInterpreter",
    languageName: 'en',
    mixerLevel: 50,
    output: "Language 4"
  }
]



/*********************************************************
 * Do not change below
**********************************************************/

let timer;

// Monitor for new Remote Inputs and update audio routing
xapi.Status.Audio.Input.RemoteInput.on(async ({ CallId, Role, id }) => {
  console.log('Audio Remote Input:', CallId, Role, id)
  if (!CallId && !Role) return
  // Simple debounce to trigger gain update as new inputs are added
  clearTimeout(timer);
  timer = setTimeout(applyAudioRouting, 1000);
});

xapi.Event.Conference.ParticipantList.NewList.on(processNewPlist);
xapi.Event.Conference.ParticipantList.ParticipantAdded.on(processNewPlist);
xapi.Event.Conference.ParticipantList.ParticipantDeleted.on(processNewPlist);
xapi.Event.Conference.ParticipantList.ParticipantUpdated.on(processNewPlist);

// Perform initial audio check with delay to handle audio console macro
setTimeout(applyAudioRouting, 3000);

async function processNewPlist({ CallId }) {

  console.log('Processing Plist Change for CallId:', CallId)

  const result = await xapi.Command.Conference.ParticipantList.Search({ CallId });
  const participants = result?.Participant;
  if (!participants) return

  const interpreters = result.Participant.filter(({ InterpreterLanguages }) => InterpreterLanguages != '');
  const interpreterLanguages = interpreters.map(({ InterpreterLanguages }) => InterpreterLanguages.split(':')[1])
  console.log('Available Languages', JSON.stringify(interpreterLanguages));

  const siRules = audioConfig.filter(({ role }) => role == 'SimultaneousInterpreter');

  siRules.forEach(({ languageName }, index) => {
    if (interpreterLanguages.includes(languageName)) {
      selectInterpreterLanguage(index + 1, languageName)
    } else {
      // Handle removing stream if required when interpreter leaves
      // selectInterpreterLanguage(index + 1)
    }

  })


}


async function selectInterpreterLanguage(StreamId, languageName) {

  const languages = await xapi.Status.Conference.Call.SimultaneousInterpretation.Languages.get();
  const languageMatch = languages.find(({ LanguageName }) => LanguageName == languageName);
  const { LanguageCode } = languageMatch;

  if (!languageMatch) {
    console.log('No languageCode found for LanguageName:', languageName)
  }
  console.log('Select LanguageName:', languageName, 'LanguageCode:', LanguageCode, 'StreamId:', StreamId)

  xapi.Command.Conference.SimultaneousInterpretation.SelectLanguage(StreamId, LanguageCode)
}


// Updates the Input Gain for the last Remote Input to the Loudspeaker Output Group
async function applyAudioRouting() {

  const remoteInputs = await xapi.Status.Audio.Input.RemoteInput.get();
  const localOutputs = await xapi.Status.Audio.Output.LocalOutput.get();


  localOutputs.forEach(output => {

    const outputId = output.id;
    const outputName = output.Name;
    const associatedStreamId = getRuleStreamId(outputName);
    const rules = getRules(outputName);

    //console.log('OutputName:', outputName, 'StreamId:', associatedStreamId, 'Rules:', JSON.stringify(rules));

    remoteInputs.forEach(input => {

      const inputRole = input.Role;
      const inputStreamId = input?.StreamId;
      const inputId = input.id;

      if (associatedStreamId) {

        const { mixerLevel, languageName } = rules?.[0];
        const gains = getDbGains(mixerLevel);

        if (inputRole == 'Main') {
          applyRule(`${inputRole}.`, outputName, inputId, outputId, gains[1])
        } else if (inputStreamId == associatedStreamId) {
          applyRule(`${inputRole}.${associatedStreamId}.${languageName}`, outputName, inputId, outputId, gains[0])
        } else {
          applyRule(`${inputRole}.`, outputName, inputId, outputId)
        }

      } else if (rules.length > 0) {
        const gain = getGainFromRule(inputRole, outputName);
        applyRule(`${inputRole}.`, outputName, inputId, outputId, gain);
      } else {
        applyRule(`${inputRole}.`, outputName, inputId, outputId)
      }
    })
  })

}




function applyRule(inputName, outputName, InputId, OutputId, InputGain) {
  if (InputGain || InputGain == 0) {
    console.log('Updating Gain InputName:', inputName, 'InputId:', InputId, 'OutputName:', outputName, 'OutputId:', OutputId, 'InputGain:', InputGain)
    xapi.Command.Audio.LocalOutput.UpdateInputGain({ InputGain, OutputId, InputId })
  } else {
    console.log('Disconnecting InputName:', inputName, 'InputId:', InputId, 'From OutputName:', outputName, 'OutputId:', OutputId)
    xapi.Command.Audio.LocalOutput.DisconnectInput({ InputId, OutputId });
  }
}

// Returns the gain from matching role and output group name
function getGainFromRule(roleName, outputName) {
  const rule = audioConfig.find(({ role }) => role == roleName);
  const gain = rule?.outputs?.find(output => output.name == outputName)?.gain;
  return gain
}

// Returns all rules used by given output group name
function getRules(outputName) {
  return audioConfig.filter(({ output, outputs }) => {
    if (output) return output == outputName
    const outputNames = outputs.map(output => output.name)
    return outputNames.includes(outputName)
  })
}


function getRuleStreamId(outputName) {
  const siRules = audioConfig.filter(({ role }) => role == 'SimultaneousInterpreter');
  if (siRules.length == 0) return
  const index = siRules.findIndex(rule => rule.output == outputName)
  if (index == -1) return
  return index + 1
}


// Calculates db values for floor and interpreter audio levels based on mix value 0 - 100
function getDbGains(mix) {
  // Ensure mix is within bounds 0-100
  if (typeof mix !== 'number' || mix < 0 || mix > 100) {
    throw new Error('Input must be an integer between 0 and 100');
  }
  const minDb = -53;
  const maxDb = 0;
  const range = maxDb - minDb;

  // Linear interpolation, then round to nearest integer
  const gain1 = Math.round(minDb + (range * mix / 100));
  const gain2 = Math.round(minDb + (range * (100 - mix) / 100));

  return [gain1, gain2];
}