/********************************************************
 * 
 * Author:              William Mills
 *                    	Solutions Engineer
 *                    	wimills@cisco.com
 *                    	Cisco Systems
 * 
 * 
 * Version: 2-0-0
 * Released: 10/17/25
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
      name: "Loudspeaker",
      gain: 0
    }],
    aec: true
  },
  {
    role: "SimultaneousInterpreter",
    languageName: 'no',
    mixerLevel: 100,
    output: "Language: Norwegian",
    aec: true
  },
  {
    role: "SimultaneousInterpreter",
    languageName: 'auto',
    mixerLevel: 100,
    output: "Language: Auto 1"
  },
  {
    role: "SimultaneousInterpreter",
    languageName: 'auto',
    mixerLevel: 100,
    output: "Language: Auto 2"
  }
]



/*********************************************************
 * Do not change below
**********************************************************/


let remoteInputTimer;
let participantChangeTimer;
let callId;
let selectedLanguages = [];
const listeners = [];
const aecRefPrefix = 'AEC-Ref'

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
  listeners.push(xapi.Status.Audio.Input.RemoteInput.on(async ({ CallId, Role, id }) => {
    console.log('Audio Remote Input:', CallId, Role, id)
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
  console.log('Conference:', conference?.[0]?.SimultaneousInterpretation?.MixerLevel)
  fixMixerLevels(conference?.[0]?.SimultaneousInterpretation?.MixerLevel);


  const CallId = call?.[0]?.id;
  if (!CallId) {
    deleteTempLoudspeaker();

    return
  }

  setTimeout(applyAudioRouting, 2000);




}

//xapi.Event.Conference.ParticipantList.on(event => console.debug(event))
//processParticipants()

async function processParticipants({ ParticipantUpdated, ParticipantAdded, ParticipantDeleted, NewList } = {}) {

  //if(!ParticipantUpdated || !ParticipantAdded || !ParticipantDeleted || !NewList )

  const event = ParticipantDeleted ?? (ParticipantUpdated ?? (ParticipantAdded ?? NewList));
  const eventType = ParticipantAdded ? 'PacticipantAdded' :
    (ParticipantDeleted ? 'ParcitipandDeleted' : (ParticipantUpdated ? 'ParticipantUpdated' : 'NewList'));
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

  const mixerLevel = await xapi.Status.Conference.Call.SimultaneousInterpretation.MixerLevel.get();
  console.log('mixerLevel', JSON.stringify(mixerLevel))
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

  console.log('localoutputs:', localOutputs)

  // Check for existing backup
  const loudspeakerBackup = localOutputs.find(({ Name }) => Name.startsWith(aecRefPrefix));

  if (loudspeakerBackup) {
    console.log('AEC Reference Loudspeaker Already Created');
    return
  }

  // Get Loudspeaker Output and identify SI Rules using it
  const loudspeakerOutput = localOutputs.find(({ Loudspeaker }) => Loudspeaker == 'On');
  const loudspeakerConnectors = loudspeakerOutput?.Connector;
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
    for(let i=0; i<loudspeakerConnectors.length; i++ ){
      const connector = loudspeakerConnectors[i];
      if (connector != 'Ethernet.1' && connector != 'Line.6') {
        console.log('Moving Connector:', connector)
        const [ConnectorType, ConnectorId] = connector.split('.')
        await xapi.Command.Audio.LocalOutput.RemoveConnector({ ConnectorId, ConnectorType, OutputId: loudspeakerId });
        await xapi.Command.Audio.LocalOutput.AddConnector({ ConnectorId, ConnectorType, OutputId: tempLoudspeakerId });
      }
    }

    for(let i=0; i< loudspeakerInputs.length; i++){
      const {id, Gain} = loudspeakerInputs[i];
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
  const connectors = tempLoudspeaker?.Connector;

  console.log('Moving Output Connectors from output group:',  tempLoudspeaker.id , ' to group:', loudspeakerBackup.id)
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

//setTimeout(deleteTempLoudspeaker, 10*1000)


// Updates the Input Gain for the last Remote Input to the Loudspeaker Output Group
async function applyAudioRouting() {

  console.log('Applying Audio Rules: Started');

  // Disconnect All Interpreters Before Applying Audio Changes 
  await disconnectStreams();

  await createTempLoudspeaker();

  const remoteInputs = await xapi.Status.Audio.Input.RemoteInput.get();
  const localOutputs = await xapi.Status.Audio.Output.LocalOutput.get();

  console.debug('localOutputs:', localOutputs);

  console.log('Applying Non-SI Rules');
  //Apply Non-SI Rules
  for (let i = 0; i < localOutputs.length; i++) {
    for (let j = 0; j < remoteInputs.length; j++) {
      await identifyAndApplyRule(remoteInputs[j], localOutputs[i], localOutputs, ['Main', 'Presentation'])
    }
  }

  console.log('Applying SI Rules');
  //Apply SI Rules
  for (let i = 0; i < localOutputs.length; i++) {
    for (let j = 0; j < remoteInputs.length; j++) {
      await identifyAndApplyRule(remoteInputs[j], localOutputs[i], localOutputs, ['SimultaneousInterpreter'])
    }
  }



  console.log('Applying Audio Rules: Completed');

  // Re-apply Interpreter Selections
  processParticipants({});

}

async function identifyAndApplyRule(input, output, localOutputs, roles = []) {


  const loudspeaker = localOutputs.find(({ Loudspeaker }) => Loudspeaker == 'On');
  const loudspeakerId = loudspeaker?.id;
  const loudspeakerName = loudspeaker?.Name;
  const outputId = output.id;
  const outputName = output.Name;
  const associatedStreamId = getRuleStreamId(outputName);
  const rules = getRules(outputName);

  const inputRole = input.Role;
  const inputStreamId = input?.StreamId;
  const inputId = input.id;

  console.debug('identifyAndApplyRule - input:', input, '- output:', output, '- roles:', roles, 'OutputName:', outputName, '- associatedStreamId:', associatedStreamId, '- rules:', rules);


  // If Output has a SI Config, this takes priority
  if (associatedStreamId && roles.includes('SimultaneousInterpreter')) {

    const siRule = audioConfig.filter(({ role }) => role == 'SimultaneousInterpreter');
    const { mixerLevel, languageName, aec } = siRule?.[associatedStreamId - 1];
    const gains = getDbGains(mixerLevel);
    console.debug('SI Rule - outputName:', outputName, 'siRule', siRule, '- mixerLevel', mixerLevel, '- gains:', gains, '- inputRole:', inputRole)

    if (inputRole == 'Main' || inputRole == 'Presentation') {
      applyRule(localOutputs, `${inputRole}`, outputName, inputId, outputId, gains[1])
    } else if (inputStreamId == associatedStreamId) {
      applyRule(localOutputs, `${inputRole}.${associatedStreamId}.${languageName}`, outputName, inputId, outputId, gains[0])
      if (aec) {
        console.log('Linking AEC for:', loudspeakerName, languageName)
        applyRule(localOutputs, `${inputRole}.AEC`, loudspeakerName, inputId, loudspeakerId, 0)
      }
    }
    return
  }

  if (roles.includes('SimultaneousInterpreter')) return


  if (rules.length == 0 && outputId != loudspeakerId) {
    applyRule(localOutputs, `${inputRole}`, outputName, inputId, outputId)
    return
  }

  console.debug('Rules -', outputName, rules)
  const matchedRole = rules.find(({ role }) => role == inputRole);
  console.debug('MatchedRole:', JSON.stringify(matchedRole))
  if (matchedRole) {
    const matchedRoleOption = matchedRole.outputs?.find(({ name }) => name == outputName);
    console.debug('matchedRoleOption:', JSON.stringify(matchedRoleOption))
    if (!matchedRoleOption) return
    applyRule(localOutputs, `${inputRole}`, outputName, inputId, outputId, matchedRoleOption.gain)
  }

  const matchedRule = audioConfig.find(({ role }) => role == inputRole);

  if (matchedRule?.aec && outputId == loudspeakerId) {
    applyRule(localOutputs, `${inputRole}`, outputName, inputId, outputId, 0)
  }

}


function applyRule(localOutputs, inputName, outputName, InputId, OutputId, InputGain) {

  if (!localOutputs) {
    throw new Error('Unable to Apply Rule and localOutputs is undefined')
  }

  const loudspeakerId = localOutputs.find(({ Loudspeaker }) => Loudspeaker == 'On')?.id;
  console.debug('Apply Rule - inputName:', inputName, '- outputName:', outputName, '- InputId:', InputId, '- OutputId:', OutputId, '- InputGain:', InputGain, '- LoudspeakerId:', loudspeakerId, '= -54?', InputGain == -54)
  const output = localOutputs.find(({ id }) => id == OutputId);

  if (!output) {
    console.warn('Unable to find output for outputId:', OutputId);
    return
  }

  const input = output?.Input?.find(({ id }) => id == InputId);

  if (InputGain != undefined && InputGain != -54) {

    if (input) {
      if (parseInt(input?.Gain) == InputGain) return
      console.log('Updating Input Gain - InputName:', inputName, 'InputId:', InputId, 'OutputName:', outputName, 'OutputId:', OutputId, 'InputGain:', InputGain);
      xapi.Command.Audio.LocalOutput.UpdateInputGain({ InputGain, OutputId, InputId })
        .catch(e => console.error('Error Updating Gain InputName:', inputName, 'InputId:', InputId, 'OutputName:', outputName, 'OutputId:', OutputId, 'InputGain:', InputGain, 'Error Message:', e.message))
      return

    } else {
      console.log('Connecting Input - InputName:', inputName, 'InputId:', InputId, 'OutputName:', outputName, 'OutputId:', OutputId, 'InputGain:', InputGain)
      xapi.Command.Audio.LocalOutput.ConnectInput({ InputGain, InputId, OutputId })
        .catch(e => console.error('Error Connect Input - InputName:', inputName, 'InputId:', InputId, 'OutputName:', outputName, 'OutputId:', OutputId, 'InputGain:', InputGain, 'Error Message:', e.message))
      return
    }
  } else if (input) {
    console.log('Disconnecting InputName:', inputName, 'InputId:', InputId, 'From OutputName:', outputName, 'OutputId:', OutputId)
    xapi.Command.Audio.LocalOutput.DisconnectInput({ InputId, OutputId })
      .catch(e => console.error('Error Disconnecting - InputName:', inputName, 'InputId:', InputId, 'From OutputName:', outputName, 'OutputId:', OutputId, 'Error Message:', e.message))
    return
  }

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
