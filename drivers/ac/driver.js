const { Driver } = require('homey');

const Uuid = require('uuid');

const HttpApi = require('../../lib/httpApi');
const AmqpApi = require('../../lib/amqpApi');
const Constants = require('../../lib/constants');
const EnergyConsumption = require('../../lib/energyConsumption');

class ACDriver extends Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('ACDriver has been initialized');
    let deviceID = await this.homey.settings.get(
      Constants.SettingDriverDeviceID,
    );
    if (!deviceID) {
      deviceID = `Homey-${Uuid.v4()}`;
      this.homey.settings.set(Constants.SettingDriverDeviceID, deviceID);
    }
    this.deviceId = deviceID;

    this.httpAPI = new HttpApi(this.homey);

    if (await this.homey.settings.get(Constants.SettingUserName)) {
      await this.initializeAmqp();
    }

    this.energyConsumption = new EnergyConsumption(this);

    this.initEnergyTimer();
  }

  async initEnergyTimer() {
    const devices = this.getDevices();
    devices.forEach(device => device.setEnergyIntervalTimer());
  }

  async initializeAmqp(retryCount = 0) {
    try {
      const token = await this.httpAPI.getSASToken(this.deviceId);
      if (!this.amqpAPI) {
        this.amqpAPI = new AmqpApi(token, this);
      } else {
        this.amqpAPI.setToken(token);
      }
    } catch (ex) {
      const maxRetries = 5;
      if (retryCount >= maxRetries) {
        this.error(`initializeAmqp failed after ${maxRetries} retries: ${ex.message}`);
        return;
      }
      // exponential backoff (1, 2, 4, 8, 16 minutes) so a 429 doesn't
      // immediately trigger another request
      const delay = 2 ** retryCount * 60 * 1000;
      this.log(`initializeAmqp failed (${ex.message}), retrying in ${delay / 1000}s`);
      this.homey.setTimeout(() => this.initializeAmqp(retryCount + 1), delay);
    }
  }

  async onPair(session) {
    this.log('Pairing session started');
    session.setHandler('showView', async viewId => {
      this.log(`Pairing: showing view '${viewId}'`);
    });
    session.setHandler('login', async data => {
      return this.login(data.username, data.password);
    });
    session.setHandler('list_devices', async () => {
      const devices = await this.httpAPI.getACs();
      return devices;
    });
  }

  async onRepair(session, device) {
     session.setHandler('login', async data => {
      return this.login(data.username, data.password);
    });
  }

  async login(username, password) {
    this.log(`Login attempt for username: ${username}`);

    // save the username and password
    this.homey.settings.set(Constants.SettingUserName, username);
    this.homey.settings.set(Constants.SettingPassword, password);

    let resobj;
    try {
      resobj = await this.httpAPI.login(username, password, this.deviceId);
    } catch (ex) {
      this.error(`Login failed: ${ex.message}`);
      throw ex;
    }
    if (resobj.IsSuccess) {
      this.log('Login successful');
      this.initializeAmqp();
    }
    // return true to continue adding the device if the login succeeded
    // return false to indicate to the user the login attempt failed
    // thrown errors will also be shown to the user
    return resobj.IsSuccess;
  }

  async sendMessage(message) {
    await this.amqpAPI.sendMessage(message);
  }

  onAmqpError(err) {
    this.error(`AMQP client error: ${err.message}`);

    // debounce: an unhealthy connection can emit several error events in a
    // row, don't fire off a reconnect (and a fresh token request) for each
    const now = Date.now();
    if (this.lastAmqpErrorAt && now - this.lastAmqpErrorAt < 60 * 1000) {
      return;
    }
    this.lastAmqpErrorAt = now;

    // the cached SAS token may have been rejected by Azure even though it
    // hadn't expired yet per our locally parsed expiry - drop it so the
    // reconnect fetches a fresh one instead of retrying with the same token
    this.homey.settings.unset(Constants.SettingSasToken);
    this.homey.settings.unset(Constants.SettingSasTokenExpiry);
    this.initializeAmqp();
  }

}
module.exports = ACDriver;
