/********************************************************
 * 
 * Author:              William Mills
 *                    	Solutions Engineer
 *                    	wimills@cisco.com
 *                    	Cisco Systems
 * 
 * 
 * Version: 3-0-0
 * Released: 11/11/25
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
    }],
    aec: true
  },
  {
    role: "Presentation",
    outputs: [{
      name: "Front Speakers",
      gain: 0
    }],
    aec: true
  },
  {
    role: "SimultaneousInterpreter",
    languageName: 'no',
    mixerLevel: 100,
    output: "Language 1",
    aec: true
  },
  {
    role: "SimultaneousInterpreter",
    languageName: 'auto',
    mixerLevel: 100,
    output: "Language 2"
  },
  {
    role: "SimultaneousInterpreter",
    languageName: 'auto',
    mixerLevel: 100,
    output: "Language 3"
  },
  {
    role: "SimultaneousInterpreter",
    languageName: 'auto',
    mixerLevel: 100,
    output: "Language 4"
  }
]



/*********************************************************
 * Do not change below
**********************************************************/

const debug = false;
const listeners = [];
const aecRefPrefix = 'AEC-Ref';

let selectedLanguages = [];
let remoteInputTimer;
let participantChangeTimer;
let callId;


xapi.Config.Audio.Output.ConnectorSetup.on(init);
xapi.Config.Audio.Output.ConnectorSetup.get()
  .then(mode => setTimeout(init, 2000, mode))
  .catch(error => console.error('Audio Console Not Available', error))


async function init(mode) {
  const audioConsoleEnabled = mode == 'Manual'
  console.log('Audio Console Enabled:', audioConsoleEnabled)

  if (!audioConsoleEnabled) {
    while (listeners.length != 0) {
      const listener = listeners.pop();
      listener();
    }
    const Title = '⚠️ Meeting Audio Macro';
    const Text = 'Audio Console Not Enabled - Please enable and configure first before using this macro';
    xapi.Command.UserInterface.Message.Alert.Display({ Duration: 30, Text, Title });
    throw new Error(Text)
  }

  // Monitor for new Remote Inputs and update audio routing
  listeners.push(xapi.Status.Audio.Input.RemoteInput.on(async ({ CallId, Role, id, ghost }) => {
    if (ghost) return
    console.log('Audio Remote Input:', CallId, Role, id, ghost)
    if (!CallId && !Role) return

    // Simple debounce to trigger gain update as new inputs are added
    clearTimeout(remoteInputTimer);
    remoteInputTimer = setTimeout(applyAudioRouting, 1000);
  }));

  // Monitor for new Remote Inputs and update audio routing
  listeners.push(xapi.Status.Call.on(({ ghost, id }) => {
    if (!ghost) return
    console.log('Call Ended - CallId:', id, '- Deleting Temp Loudspeaker Group')
    deleteTempLoudspeaker();
  }));


  listeners.push(xapi.Event.Conference.ParticipantList.on(processParticipants));

  const call = await xapi.Status.Call.get()


  async function fixMixerLevels(level) {
    if (!level) return
    console.log('Mixer Level:', level)
    if (level == 50) return
    const call = await xapi.Status.Call.get();
    const callId = call?.[0]?.id;
    if (!callId) return
    console.log('Setting Mixer Level to 50 for CallId:', callId)
    xapi.Command.Conference.SimultaneousInterpretation.SetMixer({ CallId: callId, Level: 50 });
  }

  listeners.push(xapi.Status.Conference.Call.SimultaneousInterpretation.MixerLevel.on(processParticipants));

  const conference = await xapi.Status.Conference.Call.get();
  const mixLevel = conference?.[0]?.SimultaneousInterpretation?.MixerLevel;
  fixMixerLevels(mixLevel);


  const CallId = call?.[0]?.id;
  if (!CallId) {
    deleteTempLoudspeaker();
    return
  }

  setTimeout(applyAudioRouting, 2000);

}


async function processParticipants({ ParticipantUpdated, ParticipantAdded, ParticipantDeleted, NewList } = {}) {

  const event = ParticipantDeleted ?? (ParticipantUpdated ?? (ParticipantAdded ?? NewList));

  const eventType = ParticipantAdded ?
    'PacticipantAdded' :
    (ParticipantDeleted ?
      'ParcitipandDeleted' :
      (ParticipantUpdated ?
        'ParticipantUpdated' : 'NewList'));

  const CallId = event?.CallId ?? await xapi.Status.Call.get().then(call => call?.[0]?.id);
  if (!CallId) return

  if (eventType == 'NewList' && CallId != callId) {
    callId = CallId;
  } else if (eventType == 'NewList' && CallId == callId) {
    return
  }


  console.log('Processing Participants for CallId:', CallId, '- EventType: ', eventType ?? 'none');
  const interpreterLanguages = event?.InterpreterLanguages?.split(":");

  if (interpreterLanguages && ParticipantAdded) {
    // SI Participant Added
    const bothLanguagesSelected = arrayIncludesArray(selectedLanguages, interpreterLanguages);
    if (bothLanguagesSelected) {
      console.log(interpreterLanguages, ' - Already Selected - Ingoring New Participant Update')
      return // Both languages already selected, ignoring change
    }
  }

  if (interpreterLanguages && (!ParticipantAdded && !ParticipantDeleted)) {
    // Ignore SI Participant Events where eventType isn't updated or deleted
    console.log('Ignoring Event Type:', eventType)
    return
  }

  clearTimeout(participantChangeTimer);
  participantChangeTimer = setTimeout(processAvailableLanguages, 1000, CallId)

}

async function processAvailableLanguages(CallId) {

  console.log('Processing Languages for CallId:', CallId)

  // Query All Participants
  const result = await xapi.Command.Conference.ParticipantList.Search({ CallId });

  const participants = result?.Participant;

  if (!participants) {
    console.log('No Participants Found For CallId:', CallId)
    return
  }

  // Identify all available language names
  const interpreters = participants.filter(({ InterpreterLanguages }) => InterpreterLanguages != '');
  const interpretersLanguages = interpreters.map(({ InterpreterLanguages }) => InterpreterLanguages)
  const availableLanguageNames = getUniqueLanguageCodes(interpretersLanguages);
  console.log('Available Languages:', JSON.stringify(availableLanguageNames));

  const siRules = audioConfig.filter(({ role }) => role == 'SimultaneousInterpreter');

  const configuredLanguages = siRules.map(({ languageName }) => languageName);
  const staticLanguageStreams = siRules.filter(({ languageName }) => languageName != 'auto').map(({ languageName }) => languageName);
  console.log('Configured Languages:', JSON.stringify(configuredLanguages));

  const autoLanguages = [];

  await Promise.all(configuredLanguages.map(async (languageName, index) => {
    if (languageName == 'auto') {
      const availableLanguage = findAvailableLanguage(configuredLanguages.concat(autoLanguages), availableLanguageNames);
      if (availableLanguage) {
        // Select additional Languages if there are available streams
        autoLanguages.push(availableLanguage)
        await selectInterpreterLanguage(index + 1, availableLanguage);
      }
    } else if (availableLanguageNames.includes(languageName)) {
      // Select Configured Language if available (Language Interpreter In Meeting )
      await selectInterpreterLanguage(index + 1, languageName);
    } else {
      // Disconnect Configured Language if not available (e.g. Language Interpreter Leaves Meeting)
      await selectInterpreterLanguage(index + 1);
    }
  }))

  // Store Selected Languages
  selectedLanguages = staticLanguageStreams.concat(autoLanguages);
  console.log('Selected Languages:', JSON.stringify(selectedLanguages));

  const conferenceCall = await xapi.Status.Conference.Call.get();

  console.log(JSON.stringify(conferenceCall))

  const mixerLevel = conferenceCall?.[0]?.SimultaneousInterpretation?.MixerLevel;

  if (!mixerLevel) {

    return
  }


  console.log('Current Mixer Level:', mixerLevel)
  if (mixerLevel == 50) return
  console.log('Setting Mixer Level to 50 for CallId:', CallId)
  xapi.Command.Conference.SimultaneousInterpretation.SetMixer({ CallId, Level: 50 });
}



async function selectInterpreterLanguage(StreamId, languageName) {
  if (!languageName) {

    const conference = await xapi.Status.Conference.get();
    const streams = conference?.Call?.[0]?.SimultaneousInterpretation?.Streams;

    if (!streams) return
    const streamIds = streams.map(({ Id }) => parseInt(Id))
    if (!streamIds.includes(StreamId)) return
    console.log('Disconnecting SI StreamId:', StreamId)

    try {
      await xapi.Command.Conference.SimultaneousInterpretation.SelectLanguage({ StreamId: StreamId, LanguageCode: '0' })
    } catch (error) {
      console.log('Error Removing SI StreamId:', StreamId, '- Message:', error?.message)
    }

    return
  }


  const languages = await xapi.Status.Conference.Call.SimultaneousInterpretation.Languages.get();
  const languageMatch = languages.find(({ LanguageName }) => LanguageName == languageName);
  const { LanguageCode } = languageMatch;

  if (!languageMatch) {
    console.log('No languageCode found for LanguageName:', languageName)
  }
  console.log('Connecting LanguageName:', languageName, 'LanguageCode:', LanguageCode, 'StreamId:', StreamId)

  try {
    await xapi.Command.Conference.SimultaneousInterpretation.SelectLanguage({ StreamId: StreamId, LanguageCode: LanguageCode })
  } catch (error) {
    console.log('Error Selecting Selecting SI LanguageCode: ', LanguageCode, '-StreamId:', StreamId, '- Message:', error?.message)
  }
}

async function createTempLoudspeaker() {

  console.log('Creating AEC Reference Loudspeaker Output Group')
  const localOutputs = await xapi.Status.Audio.Output.LocalOutput.get();

  console.debug('localoutputs:', localOutputs)

  // Check for existing backup
  const loudspeakerBackup = localOutputs.find(({ Name }) => Name.startsWith(aecRefPrefix));

  if (loudspeakerBackup) {
    console.log('AEC Reference Loudspeaker Already Created');
    return
  }

  // Get Loudspeaker Output and identify SI Rules using it
  const loudspeakerOutput = localOutputs.find(({ Loudspeaker }) => Loudspeaker == 'On');
  const loudspeakerConnectors = loudspeakerOutput?.Connector ?? [];
  const loudspeakerInputs = loudspeakerOutput?.Input;
  const loudspeakerId = loudspeakerOutput?.id;
  const loudspeakerName = loudspeakerOutput?.Name;

  if (!loudspeakerOutput) {
    console.log('Failed to create AEC Reference Loudspeaker as no existing loudspeaker group found');
    return
  }

  // Check if loudspeaker group already has prefix
  if (!loudspeakerName.startsWith(aecRefPrefix)) {
    await xapi.Command.Audio.LocalOutput.Update({ Name: aecRefPrefix + '-' + loudspeakerName, AutoconnectRemote: "Off", OutputId: loudspeakerId });
  }

  // Identify any existing temp Loudspeaker Output Group
  const tempLoudspeaker = localOutputs.find(({ Name, id }) => Name == loudspeakerName && id != loudspeakerId);
  let tempLoudspeakerId = tempLoudspeaker?.id;

  // Create new Temp Loudspeaker Output Group if none exists and SI Rule uses the Loudspeaker
  if (!tempLoudspeakerId) {
    console.log('Creating Temp Loadspeaker Output Group')
    const newTempLoudspeaker = await xapi.Command.Audio.LocalOutput.Add({ AutoconnectRemote: "Off", Name: loudspeakerName, VolumeControlled: 'On' });
    tempLoudspeakerId = newTempLoudspeaker?.OutputId;
  }

  // Move all but the Ethernet.1 and Line.6 Output connectors to Temp Loudspeaker Output Group.
  if (tempLoudspeakerId) {
    console.log('Moving Output Connectors from output group:', loudspeakerId, ' to group:', tempLoudspeakerId)
    for (let i = 0; i < loudspeakerConnectors.length; i++) {
      const connector = loudspeakerConnectors[i];
      if (connector != 'Ethernet.1' && connector != 'Line.6') {
        console.log('Moving Connector:', connector)
        const [ConnectorType, ConnectorId] = connector.split('.')
        await xapi.Command.Audio.LocalOutput.RemoveConnector({ ConnectorId, ConnectorType, OutputId: loudspeakerId });
        await xapi.Command.Audio.LocalOutput.AddConnector({ ConnectorId, ConnectorType, OutputId: tempLoudspeakerId });
      }
    }

    for (let i = 0; i < loudspeakerInputs.length; i++) {
      const { id, Gain } = loudspeakerInputs[i];
      xapi.Command.Audio.LocalOutput.ConnectInput({ InputGain: Gain, InputId: id, OutputId: tempLoudspeakerId });
    }

  }

}

async function deleteTempLoudspeaker() {

  console.log('Deleting AEC Reference Loudspeaker Output Group');

  const localOutputs = await xapi.Status.Audio.Output.LocalOutput.get();

  // Find LoudspeakerBackup Output Group
  const loudspeakerBackup = localOutputs.find(({ Name }) => Name.startsWith(aecRefPrefix));
  if (!loudspeakerBackup) return

  const loudspeakerName = loudspeakerBackup?.Name.replace(aecRefPrefix + '-', '');
  console.log('Origional Loudspeaker Name', loudspeakerName)

  // Find Loudspeaker Output Group
  const tempLoudspeaker = localOutputs.find(({ Name }) => Name == loudspeakerName);
  if (!tempLoudspeaker) {
    console.log('Temp Loudspeaker Not Found')
    return
  }

  // Move all connectors from temp group back to loudspeaker group
  console.log('Found Temp Loudspeaker:', tempLoudspeaker)
  const connectors = tempLoudspeaker?.Connector ?? [];


  console.log('Moving Output Connectors from output group:', tempLoudspeaker.id, ' to group:', loudspeakerBackup.id)
  for (let i = 0; i < connectors.length; i++) {
    const connector = connectors[i]
    console.log('Moving Connector:', connector)
    const [ConnectorType, ConnectorId] = connector.split('.')
    await xapi.Command.Audio.LocalOutput.RemoveConnector({ ConnectorId, ConnectorType, OutputId: tempLoudspeaker.id });
    await xapi.Command.Audio.LocalOutput.AddConnector({ ConnectorId, ConnectorType, OutputId: loudspeakerBackup.id });
  }

  // Delete temp output group
  await xapi.Command.Audio.LocalOutput.Remove({ OutputId: tempLoudspeaker.id });
  await xapi.Command.Audio.LocalOutput.Update({ Name: tempLoudspeaker.Name, OutputId: loudspeakerBackup.id });
  console.log('Temp Loudspeaker Output Group Deleted');
}


// Updates the Input Gain for the last Remote Input to the Loudspeaker Output Group
async function applyAudioRouting() {

  console.log('Applying Audio Rules: Started');

  // Disconnect All Interpreters Before Applying Audio Changes 
  await disconnectStreams();
  await createTempLoudspeaker();

  const remoteInputs = await xapi.Status.Audio.Input.RemoteInput.get();
  const localOutputs = await xapi.Status.Audio.Output.LocalOutput.get();

  console.debug('remoteInputs:', remoteInputs);
  console.debug('localOutputs:', localOutputs);

  console.log('Applying Non-SI Rules');

  const updates = processAudioConnections(remoteInputs, localOutputs, audioConfig);
  // console.debug(JSON.stringify(updates, null, 2));

  for (const [key, values] of Object.entries(updates)) {
    for (let i = 0; i < values.length; i++) {
      const xCommand = `xapi.Command.Audio.LocalOutput.${key}(${JSON.stringify(values[i])})`;
      try {
        console.debug('Calling xAPI [', xCommand, ']');
        await xapi.Command.Audio.LocalOutput[key](values[i]);
      } catch (error) {
        console.debug('Error Calling xAPI [', xCommand, '] - Message:', error.message);
      }
    }
  }

  console.log('Applying Audio Rules: Completed');

  const hasSiRule = audioConfig.find(({ role }) => role == 'SimultaneousInterpreter');

  if (!hasSiRule) {
    console.log('No SI Rules Found')
    return
  }

  // Re-apply Interpreter Selections
  processParticipants({});

}

function processAudioConnections(inputs, outputs, rules) {

  const nonSiRules = rules.filter(({ role }) => role != 'SimultaneousInterpreter');
  const siRules = rules.filter(({ role }) => role == 'SimultaneousInterpreter');

  if (debug) console.log('siRules:', siRules)
  if (debug) console.log('siRule has Language 2', siRules.some(({ output }) => output == 'Language 2'))

  const rulesByRole = new Map(nonSiRules.map(rule => [rule.role, rule]));
  const rulesByStreamId = new Map(siRules.map((rule, index) => [index + 1, rule]));
  const mainInputIds = inputs.filter(({ Role }) => Role === 'Main').map(({ id }) => id);

  // Create Change Arrays
  const Update = []
  const ConnectInput = [];
  const UpdateInputGain = [];
  const DisconnectInput = [];

  // Approach:
  // Loop throught outputs and inputs
  // Connect AEC links if processing loudspaker output and input has AEC set to true
  //
  // SimultaneousInterpreter Roles: 
  // 1. Lookup Rule by Stream Id
  // 2. No Rule found but connected to output - disconnect input and return
  // 3. Rule found but not for output group:
  //   a. Loudspeaker Output Group and AEC Required - Ignore and return
  //   b. Not connected to output - Ignore and return
  //   c. Otherwise disconnect input from output
  // 4. Get Mixer Gains
  // 5. Update or Add Connection from SI Role input to output group
  // 6. Update or Add Connection to Main Role inputs to output group
  // 7. return
  //
  // Main and Presentation Roles: 
  // 1. Identify conditions:
  //   a: Is Output Group configure under any SI Rules
  //.  b: Is there a connection gain for this input to the output group name
  // 2. If InputGain exists, update or connect if required  and return
  // 3. If not connections and no gain - Ignore and return
  // 4. If on loadspeaker and require AEC - ignore and return as this was handled
  // 5. If output has an SI Rule and Input Role is Main - Ignore and return
  // 6. Delete all other remaining connections

  // Loop though each output group
  outputs.map(output => {

    // Create map of each input connections id to Gain
    const outputInputIds = new Map(output?.Input?.map(({ id, Gain }) => [id, Gain]));

    // Note if Output Group is set as Loudspeaker
    const loudspeaker = output?.Loudspeaker == 'On';

    // Store OutputId for change arrays
    const OutputId = output?.id;


    // Check if outputs group name is present in any rule
    const anyRule = getRules(output.Name);

    // If output goup has a rule for an remote input role
    // disable its AutoconnectRemote is present
    if (anyRule && output.AutoconnectRemote == 'On') {
      Update.push({ OutputId, AutoconnectRemote: 'Off' })
    }


    // Loop though each remote inputs
    inputs.forEach(({ id: InputId, Role, StreamId }) => {

      const rule = rulesByRole.get(Role) ?? rulesByStreamId.get(parseInt(StreamId));
      const siOutputGroup = siRules.some(rule => rule?.output == output?.Name);

      const requireAEC = rule?.aec ?? false;

      if (debug) console.error('Role:', Role, '| OutputName:', output.Name, '| Rule:', rule, '| requireAEC:', requireAEC)

      if (loudspeaker && requireAEC) {
        if (outputInputIds.has(InputId) && outputInputIds.get(InputId) != 0) {
          if (debug) console.warn('Updated AEC Gain - Role:', Role, 'InputId:', InputId, ' - OutputId:', OutputId, 'OutputName:', output.Name)
          UpdateInputGain.push({ InputGain: 0, InputId, OutputId });
        } else if (!outputInputIds.has(InputId)) {
          if (debug) console.warn('Connecting AEC  - Role:', Role, 'InputId:', InputId, ' - OutputId:', OutputId, 'OutputName:', output.Name)
          ConnectInput.push({ InputGain: 0, InputId, OutputId });
        }
      } else if (loudspeaker && !requireAEC) {
        if (debug) console.warn('Disconnecting AEC  - Role:', Role, 'InputId:', InputId, ' - OutputId:', OutputId, 'OutputName:', output.Name)
        DisconnectInput.push({ InputId, OutputId });
      }

      // Handle SI Roles separately
      if (Role == 'SimultaneousInterpreter') {

        if (debug) console.log('SimultaneousInterpreter StreamId:', StreamId, 'outputInputIds.has(InputId)', outputInputIds.has(InputId), '!rule', !rule)

        // If there no rule for stream id but InputId is present - disconnection input
        if (!rule && outputInputIds.has(InputId)) {
          if (debug) console.warn('No Rule and has connection - Disconnecting streamId:', StreamId, 'InputId:', InputId, 'OutputId:', OutputId, 'OutputName:', output.Name)
          DisconnectInput.push({ InputId, OutputId })
          return
        }

        if (rule?.output != output.Name) {
          if (loudspeaker && requireAEC) return
          if (!outputInputIds.has(InputId)) return
          if (debug) console.warn('Disconnecting streamId:', StreamId, 'InputId:', InputId, 'OutputId:', OutputId, 'OutputName:', output.Name)
          DisconnectInput.push({ InputId, OutputId })
          return
        }

        const [interpreter, floor] = getDbGains(rule?.mixerLevel);

        if (outputInputIds.has(InputId)) {
          if (debug) console.warn('Updating Gain streamId:', StreamId, 'InputId:', InputId, 'OutputId:', OutputId, 'OutputName:', output.Name)
          UpdateInputGain.push({ InputGain: interpreter, InputId, OutputId });
        } else {
          if (debug) console.warn('Connecting Gain streamId:', StreamId, 'InputId:', InputId, 'OutputId:', OutputId, 'OutputName:', output.Name)
          ConnectInput.push({ InputGain: interpreter, InputId, OutputId });
        }

        if (debug) console.log('Main Input Ids:', mainInputIds)

        mainInputIds.forEach(InputId => {
          if (outputInputIds.has(InputId)) {
            if (debug) console.warn('Updating Gain InputName: Main | StreamId:', StreamId, '| InputId:', InputId, '| OutputId:', OutputId, '| OutputName:', output.Name)
            UpdateInputGain.push({ InputGain: floor, InputId, OutputId });
          } else {
            if (debug) console.warn('Connecting Input InputName: Main | StreamId:', StreamId, '| InputId:', InputId, '| OutputId:', OutputId, '| OutputName:', output.Name)
            ConnectInput.push({ InputGain: floor, InputId, OutputId });
          }
        })

        return

      }

      // Handle Main and Presentation Roles


      const ruleOutput = rule?.outputs?.find(({ name }) => name === output.Name);
      const InputGain = ruleOutput?.gain;

      if (debug) console.log('Remote Input - Role:', Role, 'InputId:', InputId, 'OutputName:', output.Name, 'OutputId:', OutputId, 'AEC:', requireAEC, 'Matched Rule:', rule, 'siOutputGroup:', siOutputGroup, 'ruleOutput:', ruleOutput, 'InputGain', InputGain)

      if (InputGain != undefined) {
        if (outputInputIds.has(InputId)) {
          if (outputInputIds.get(InputId) == InputGain) {
            if (debug) console.warn('No Rule + Has Connection + RequireAEC + Gain 0 = No Action - InputId:', InputId, ' - OutputId:', OutputId);
            return
          }
          if (debug) console.warn('No Rule + Has Connection + RequireAEC - Bad Gain = Updating Gain - InputId:', InputId, ' - OutputId:', OutputId);
          UpdateInputGain.push({ InputGain: 0, InputId, OutputId });
          return
        } else {
          if (debug) console.warn('Connecting Input - Role:', Role, 'InputId:', InputId, ' - OutputId:', OutputId, 'OutputName:', output.Name)
          ConnectInput.push({ InputGain, InputId, OutputId });
          return
        }
      }


      if (!outputInputIds.has(InputId)) {
        if (debug) console.warn('No Rule - No Inputs = No Action - InputId:', InputId, ' - OutputId:', OutputId)
        return
      }


      if (loudspeaker && requireAEC) {
        if (debug) console.warn('No Rule - Has Inputs = Requires AEC = No Action - InputId:', InputId, ' - OutputId:', OutputId)
        return
      }

      // Remove connection if no role rule but connection is present
      if (siOutputGroup && Role == 'Main') {
        if (debug) console.warn('Disconnecting Input due to no rule rule and no SI Output A - InputId:', InputId, ' - OutputId:', OutputId);
        return
      }

      if (debug) console.warn('Disconnecting Input due to no rule rule and no SI Output A - InputId:', InputId, ' - OutputId:', OutputId);
      DisconnectInput.push({ InputId, OutputId })

    });

  });

  return { Update, ConnectInput, UpdateInputGain, DisconnectInput }

}


async function disconnectStreams() {
  selectedLanguages = [];
  const conference = await xapi.Status.Conference.get();
  const streams = conference?.Call?.[0]?.SimultaneousInterpretation?.Streams;
  if (!streams) return
  const streamIds = streams.map(({ Id }) => parseInt(Id));
  await Promise.all(streamIds.map(async StreamId => {
    console.log('Disconnecting Simultaneous Interpretation StreamId:', StreamId);
    await xapi.Command.Conference.SimultaneousInterpretation.SelectLanguage({ StreamId: StreamId, LanguageCode: '0' })
  }))
}



// Returns all rules used by given output group name
function getRules(outputName) {
  return audioConfig.filter(({ output, outputs }) => {
    if (output) return output == outputName
    const outputNames = outputs.map(output => output.name)
    return outputNames.includes(outputName)
  })
}



function getUniqueLanguageCodes(languagePairs) {
  const uniqueCodes = new Set();
  for (const pair of languagePairs) {
    const codes = pair.split(':');
    if (codes.length === 2) {
      uniqueCodes.add(codes[0].trim());
      uniqueCodes.add(codes[1].trim());
    }
  }

  return Array.from(uniqueCodes);
}

function findAvailableLanguage(configured, available) {
  for (const language of available) {
    if (!configured.includes(language)) {
      return language;
    }
  }
}



function arrayIncludesArray(arr1, arr2) {
  if (arr1 == undefined || arr2 == undefined) return false;
  for (const item of arr2) {
    if (!arr1.includes(item)) {
      return false;
    }
  }
  return true
}

function loudnessRatioToDecibels(ratio) {
  const minDecibels = -54.0;
  const minRatio = 0.05;
  if (ratio > minRatio) {
    return 10.0 * Math.log(ratio) / Math.log(2);
  }
  return minDecibels;
}


// Calculates array db values for floor and interpreter audio levels based on mix value 0 - 100
function getDbGains(mixLevel) {
  const level = Math.round(mixLevel);

  const maxLevel = 100;
  const midLevel = 50;

  if (level >= midLevel) {
    const floorRatio = (maxLevel - level) / level;
    return [0, Math.round(loudnessRatioToDecibels(floorRatio))];
  }

  const interpRatio = (level) / (maxLevel - level);
  return [Math.round(loudnessRatioToDecibels(interpRatio)), 0];
}

function createPanel() {

  const panelId = 'simultaneousInterpretation';
  const output = [];
  const languages = [];

  const panel = `
  <Extensions>
    <Panel>
      <Origin>local</Origin>
      <Location>HomeScreenAndCallControls</Location>
      <Icon>Language</Icon>
      <Name>Interpreter Controls</Name>
      <ActivityType>Custom</ActivityType>
      <Page>
        <Name>🌐 Interpreter Controls</Name>
        <Row>
          <Name>Selected Language</Name>
          <Widget>
            <WidgetId>widget_12</WidgetId>
            <Name>Change Language</Name>
            <Type>Text</Type>
            <Options>size=1;fontSize=small;align=center</Options>
          </Widget>
          <Widget>
            <WidgetId>widget_11</WidgetId>
            <Name>Original Audio</Name>
            <Type>Text</Type>
            <Options>size=1;fontSize=small;align=center</Options>
          </Widget>
          <Widget>
            <WidgetId>widget_3</WidgetId>
            <Name>Mixer</Name>
            <Type>Text</Type>
            <Options>size=1;fontSize=small;align=center</Options>
          </Widget>
          <Widget>
            <WidgetId>widget_10</WidgetId>
            <Name>Interpreter</Name>
            <Type>Text</Type>
            <Options>size=1;fontSize=small;align=right</Options>
          </Widget>
        </Row>
        <Row>
          <Name>[Line 1] Norwegian</Name>
          <Widget>
            <WidgetId>widget_19</WidgetId>
            <Name>Fixed</Name>
            <Type>Text</Type>
            <Options>size=1;fontSize=normal;align=center</Options>
          </Widget>
          <Widget>
            <WidgetId>widget_5</WidgetId>
            <Type>Slider</Type>
            <Options>size=3</Options>
          </Widget>
        </Row>
        <Row>
          <Name>[Line 2] English ( Auto )</Name>
          <Widget>
            <WidgetId>widget_14</WidgetId>
            <Type>Button</Type>
            <Options>size=1;icon=list</Options>
          </Widget>
          <Widget>
            <WidgetId>widget_7</WidgetId>
            <Type>Slider</Type>
            <Options>size=3</Options>
          </Widget>
        </Row>
        <Row>
          <Name>[Line 3] None Selected</Name>
          <Widget>
            <WidgetId>widget_15</WidgetId>
            <Type>Button</Type>
            <Options>size=1;icon=plus</Options>
          </Widget>
          <Widget>
            <WidgetId>widget_17</WidgetId>
            <Type>Spacer</Type>
            <Options>size=3</Options>
          </Widget>
        </Row>
        <Row>
          <Name>[Line 4] None Selected</Name>
          <Widget>
            <WidgetId>widget_16</WidgetId>
            <Type>Button</Type>
            <Options>size=1;icon=plus</Options>
          </Widget>
          <Widget>
            <WidgetId>widget_18</WidgetId>
            <Type>Spacer</Type>
            <Options>size=3</Options>
          </Widget>
        </Row>
        <Row>
          <Name>                       Available Languages:</Name>
          <Widget>
            <WidgetId>widget_20</WidgetId>
            <Name>French, Spanish, German</Name>
            <Type>Text</Type>
            <Options>size=4;fontSize=normal;align=left</Options>
          </Widget>
        </Row>
        <Options/>
      </Page>
    </Panel>
  </Extensions>`;


  xapi.Command.UserInterface.Extensions.Panel.Save({ PanelId: panelId }, panel);
}
