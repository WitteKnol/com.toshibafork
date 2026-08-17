const { Device } = require('homey');
const { DateTime } = require('luxon');
const StateUtils = require('../../lib/stateUtils');
const {
  logError,
  setCapabilities,
  disabledMeritAForMode,
  disabledMeritBForMode,
} = require('../../lib/acFeatures');
const Constants = require('../../lib/constants');
const ValidityChecks = require('../../lib/validityChecks');

let acMode = '';
let swingMode = '';
const capabilitiesInFlow = [
  Constants.CapabilityTargetTemperatureInside,
  Constants.CapabilityTargetMeritA,
  Constants.CapabilityTargetMeritB,
  Constants.CapabilityTargetAirPureIon,
  Constants.CapabilityTargetPowerMode,
  Constants.CapabilityTargetFanMode,
  Constants.CapabilityTargetACMode1,
  Constants.CapabilityTargetACMode2,
  Constants.CapabilityTargetACMode3,
  Constants.CapabilityTargetSwingMode1,
  Constants.CapabilityTargetSwingMode2,
  Constants.CapabilityTargetSwingMode3,
  Constants.CapabilityTargetSwingMode4,
];

class ACDevice extends Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    await this.initCapabilities().catch(error => logError(this, error));
    const hasEnergyCapability = this.hasCapability(
      Constants.CapabilityEnergyConsumptionToday,
    );
    if( hasEnergyCapability){
      this.addCapability( Constants.CapabilityMeterPower);
      this.removeCapability( Constants.CapabilityEnergyConsumptionToday );
    }
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('ACDevice has been added');
    // determine the capabilities for this type of AC
    await setCapabilities(this).catch(error => logError(this, error));
    // set starting values for the AC
    const state = await this.getStoreValue(Constants.StoredValueState).catch(
      error => logError(this, error),
    );
    StateUtils.convertStateToCapabilities(this, state);
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('ACDevice settings where changed');
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log('ACDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('ACDevice has been deleted');
    if (this.timerId) {
      this.homey.clearInterval(this.timerId);
    }
  }

  async initCapabilities() {
    // initialize the capability listeners
    acMode = this.getStoreValue(Constants.StoredCapabilityTargetACMode);
    swingMode = this.getStoreValue(Constants.StoredCapabilityTargetSwingMode);

    const capabilities = [
      Constants.CapabilityOnOff,
      Constants.CapabilityTargetTemperatureInside,
      Constants.CapabilityTargetFanMode,
      Constants.CapabilityTargetPowerMode,
      Constants.CapabilityTargetMeritA
    ];
    // do not add if capabilities not added (yet)
    if (acMode) {
      capabilities.push(acMode);
    }
    if (swingMode) {
      capabilities.push(swingMode);
    }
    if (this.hasCapability(Constants.CapabilityTargetMeritB)) {
      capabilities.push(Constants.CapabilityTargetMeritB);
    }

    this.registerMultipleCapabilityListener(
      capabilities,
      async (capabilityValues, capabilityOptions) => {
        await this.updateCapabilities(capabilityValues).catch(error => logError(this, error));
      },
    );
  }

  async updateCapabilities(capabilityValues) {
    const isValid = ValidityChecks.isValid(this, capabilityValues);
    if (!isValid.valid) {
      throw new Error(isValid.errormessage);
    }
    // Tracks every capability actually touched by this command cycle, so
    // updateStateAfterUpdateCapability() only sends real values for those -
    // everything else goes out as NONE_VAL (untouched), matching the
    // official app instead of re-asserting Homey's full cached state on
    // every single command.
    const changedKeys = new Set(Object.keys(capabilityValues));
    for (const [key, value] of Object.entries(capabilityValues)) {
      const oldvalue = this.getCapabilityValue(key);
      await this.setCapabilityValue(key, value).catch(error => logError(this, error));
      if (
        key === Constants.CapabilityTargetMeritA
        && value === Constants.MeritA_Heating_8C
      ) {
        await this.setCapabilityValue(acMode, Constants.Heat).catch(error => logError(this, error));
        changedKeys.add(acMode);
        // in 8C mode, meritB has to be turned off
        if (this.hasCapability(Constants.CapabilityTargetMeritB)) {
          await this.setCapabilityValue(
            Constants.CapabilityTargetMeritB,
            Constants.MeritB_Off,
          ).catch(error => logError(this, error));
          changedKeys.add(Constants.CapabilityTargetMeritB);
        }
      }

      if (await this.resetMeritA(key, value).catch(error => logError(this, error))) {
        changedKeys.add(Constants.CapabilityTargetMeritA);
      }
      if (this.hasCapability(Constants.CapabilityTargetMeritB)) {
        if (await this.resetMeritB(key, value).catch(error => logError(this, error))) {
          changedKeys.add(Constants.CapabilityTargetMeritB);
        }
      }

      this.startTrigger(key, oldvalue, value);
    }
    await this.setStatusCapability().catch(error => logError(this, error));
    await this.updateStateAfterUpdateCapability(changedKeys).catch(error => logError(this, error));
  }

  // Returns true if meritA was actually reset (invalid for the new mode),
  // so the caller can track it as an explicitly changed capability.
  async resetMeritA(key, value) {
    if (
      key === Constants.CapabilityTargetACMode1
      || key === Constants.CapabilityTargetACMode2
      || key === Constants.CapabilityTargetACMode3
    ) {
      const valueMeritA = await this.getCapabilityValue(
        Constants.CapabilityTargetMeritA,
      );
      const isValidMeritA = ValidityChecks.checkSupportedMeritForMode(
        this,
        Constants.CapabilityTargetMeritA,
        valueMeritA,
        value,
        disabledMeritAForMode,
      ).valid;
      if (!isValidMeritA) {
        await this.setCapabilityValue(
          Constants.CapabilityTargetMeritA,
          Constants.MeritA_Off,
        ).catch(error => logError(this, error));
        return true;
      }
    }
    return false;
  }

  // Returns true if meritB was actually reset (invalid for the new mode),
  // so the caller can track it as an explicitly changed capability.
  async resetMeritB(key, value) {
    if (
      key === Constants.CapabilityTargetACMode1
      || key === Constants.CapabilityTargetACMode2
      || key === Constants.CapabilityTargetACMode3
    ) {
      const valueMeritB = await this.getCapabilityValue(
        Constants.CapabilityTargetMeritB,
      );
      const isValidMeritB = ValidityChecks.checkSupportedMeritForMode(
        this,
        Constants.CapabilityTargetMeritB,
        valueMeritB,
        value,
        disabledMeritBForMode,
      ).valid;
      if (!isValidMeritB) {
        await this.setCapabilityValue(
          Constants.CapabilityTargetMeritA,
          Constants.MeritB_Off,
        ).catch(error => logError(this, error));
        return true;
      }
    }
    return false;
  }

  async setStatusCapability() {
    if (this.hasCapability(Constants.CapabilityStatus)) {
      let value = this.getCapabilityValue(acMode);
      // Self-cleaning can run for well over an hour after an off command,
      // with onoff already reporting false throughout - check it first so
      // the status doesn't get stuck showing "Off" while the unit is still
      // physically cleaning.
      if (this.getCapabilityValue(Constants.CapabilitySelfCleaning)) {
        value = Constants.StatusCleaning;
      } else if (!this.getCapabilityValue(Constants.CapabilityOnOff)) {
        value = Constants.StatusOff;
      }
      await this.setCapabilityValue(Constants.CapabilityStatus, value).catch(
        error => logError(this, error),
      );
    }
  }

  async updateStateAfterUpdateCapability(changedKeys) {
    const state = await StateUtils.convertCapabilitiesToState(this, changedKeys).catch(
      error => logError(this, error),
    );
    await this.setStoreValue(Constants.StoredValueState, state).catch(error => logError(this, error));
    this.lastLocalCommandAt = Date.now();
    this.driver.amqpAPI.sendMessage(state, this.getData().DeviceUniqueID);
  }

  // Toshiba's cloud-side status snapshot (GetConsumerACMapping, used by the
  // driver's status poll) can briefly lag behind a command we just sent -
  // the AC and Toshiba's own backend both need a moment to catch up. Applying
  // a poll result from within that window would overwrite the state we just
  // set with stale data, e.g. turning a device that was just switched off
  // back on in Homey. Give locally issued commands a grace period to
  // propagate before trusting the poll again.
  recentlyCommandedLocally() {
    const graceMs = 2 * 60 * 1000;
    return !!this.lastLocalCommandAt && (Date.now() - this.lastLocalCommandAt) < graceMs;
  }

  async setEnergyIntervalTimer() {
    this.interval = 300;
    this.timerId = null;

    const hasEnergyCapability = this.hasCapability(
      Constants.CapabilityMeterPower,
    );

    if (hasEnergyCapability) {
      const { energyConsumption } = this.driver;
      this.timerId = this.homey.setInterval(async () => {
        const timezone = this.homey.clock.getTimezone();
        const dateTime = DateTime.local().setZone(timezone, {
          keepLocalTime: true,
        });
        
        const value = await energyConsumption
          .getNextEnergyConsumption(this, dateTime)
          .catch(error => logError(this, error));
          
          if ( value ){
            const prevValue = await this.getCapabilityValue( Constants.CapabilityMeterPower );
            const newValue = prevValue + value.addedEnergy;
            this.setCapabilityValue( Constants.CapabilityMeterPower, newValue );
            this.setCapabilityValue( Constants.CapabilityEnergyConsumptionLastHour, value.lastHour )
            }
      }, this.interval * 1000);
    }
  }

  startTrigger(key, oldValue, newValue) {
    // when installing the device, oldValue=null => do not start trigger
    if (oldValue !== null && capabilitiesInFlow.find(cap => cap === key)) {
      const triggerName = this.getTriggerName(key);
      const trigger = this.homey.flow.getDeviceTriggerCard(triggerName);
      if (trigger) {
        const token = {
          oldValue,
          newValue,
        };
        trigger.trigger(this, token);
      }
    }
  }

  updateStateAfterHeartBeat(insideTemperature, outsideTemperature) {
    StateUtils.setOutsideTemperature(this, outsideTemperature);
    StateUtils.setInsideTemperature(this, insideTemperature);
  }

  async updateState(state) {
    const currentState = this.getStoreValue(Constants.StoredValueState);
    if (currentState !== state) {
      this.setStoreValue(Constants.StoredValueState, state);
      await StateUtils.convertStateToCapabilities(this, state);
      // convertStateToCapabilities updates onoff/mode/etc. but not
      // measure_status - without this, a device turned off via AMQP push or
      // the status poll (i.e. not through this Homey app itself) keeps
      // showing its last-known status (e.g. "Cool") indefinitely, even
      // though onoff correctly flips to false. Must run after
      // convertStateToCapabilities has actually resolved, not just been
      // called, or it can read stale onoff/mode values.
      await this.setStatusCapability().catch(error => logError(this, error));
    }
  }

  getResult(results, query) {
    // filter based on the query
    return results.filter(result => {
      return result.name.toLowerCase().includes(query.toLowerCase());
    });
  }

  getTriggerName(key) {
    let value = key;
    if (
      key.includes(Constants.StoredCapabilityTargetACMode)
      || key.includes(Constants.StoredCapabilityTargetSwingMode)
    ) {
      value = key.substring(0, key.length - 1);
    }
    return value;
  }

}
module.exports = ACDevice;
