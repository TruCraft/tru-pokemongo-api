'use strict';

var fs = require('fs');
var crypto = require('crypto');
var request = require('request');
var geocoder = require('geocoder');
var S2 = require('s2-geometry').S2;
var GoogleOAuth = require('gpsoauthnode');
var Logins = require('./utils/logins');
var Long = require('long');
var pogoSignature = require('node-pogo-signature');
var POGOProtos = require('node-pogo-protos');

var indexOf = [].indexOf || function(item) {
		for(var i = 0, l = this.length; i < l; i++) {
			if(i in this && this[i] === item) {
				return i;
			}
		}
		return -1;
	};

var api_url = 'https://pgorelease.nianticlabs.com/plfe/rpc';

const RequestType = POGOProtos.Networking.Requests.RequestType;
const Envelopes = POGOProtos.Networking.Envelopes;
const RequestEnvelope = Envelopes.RequestEnvelope;
const ResponseEnvelope = Envelopes.ResponseEnvelope;
const RequestMessages = POGOProtos.Networking.Requests.Messages;
const Responses = POGOProtos.Networking.Responses;

var _username;
var _password;
var error_count = 0;

function PokemonGoAPI() {
	var self = this;

	self.j = request.jar();
	self.request = request.defaults({
		jar: self.j
	});

	self.max_pokemon_name_len = null;

	self.google = new GoogleOAuth();

	self.playerInfo = {
		accessToken: null,
		debug: true,
		latitude: 0,
		longitude: 0,
		altitude: 0,
		locationName: '',
		provider: '',
		apiEndpoint: '',
		device_info: null
	};

	self.getObjKeyByValue = function(obj, val) {
		for(var i in obj) {
			if(obj[i] === val) {
				return self.formatString(i);
			}
		}
		return null;
	}

	self.formatString = function(string) {
		if(string !== null) {
			string = string.replace(/_/g, " ");
			string = string.replace(/\w\S*/g, function(txt) {
				return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
			});
		}

		return string;
	}

	// Set device info for uk6
	self.SetDeviceInfo = function(devInfo) {
		self.playerInfo.device_info = devInfo;
	};

	self.DebugPrint = function(str) {
		if(self.playerInfo.debug === true) {
			console.log(str);
		}
	};

	self.getActions = function(request_type) {
		request_type = request_type.replace(/_/g, " ");
		request_type = request_type.replace(/\w\S*/g, function(txt) {
			return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
		});
		request_type = request_type.replace(/ /g, "");
		return {message: request_type + "Message", response: request_type + "Response"};
	}

	/**
	 *
	 * @returns {{latitude: number, longitude: number, altitude: number}}
	 * @constructor
	 */
	self.GetLocationCoords = function() {
		return {
			latitude: self.playerInfo.latitude,
			longitude: self.playerInfo.longitude,
			altitude: self.playerInfo.altitude
		};
	};

	/**
	 *
	 * @param location
	 * @param callback
	 * @returns {*}
	 * @constructor
	 */
	self.SetLocation = function(location, callback) {
		if(location.type !== 'name' && location.type !== 'coords') {
			return callback(new Error('Invalid location type'));
		}

		if(location.type === 'name') {
			if(!location.name) {
				return callback(new Error('You should add a location name'));
			}
			var locationName = location.name;
			geocoder.geocode(locationName, function(err, data) {
				if(err || data.status === 'ZERO_RESULTS') {
					return callback(new Error('location not found'));
				}

				var _data$results$0$geome = data.results[0].geometry.location;
				var lat = _data$results$0$geome.lat;
				var lng = _data$results$0$geome.lng;


				self.playerInfo.latitude = lat;
				self.playerInfo.longitude = lng;
				self.playerInfo.locationName = locationName;

				callback(null);
			});
		} else if(location.type === 'coords') {
			if(!location.coords) {
				return callback(new Error('Coords object missing'));
			}

			self.playerInfo.latitude = location.coords.latitude || self.playerInfo.latitude;
			self.playerInfo.longitude = location.coords.longitude || self.playerInfo.longitude;
			self.playerInfo.altitude = location.coords.altitude || self.playerInfo.altitude;

			geocoder.reverseGeocode.apply(geocoder, self.toConsumableArray(self.GetCoords()).concat([function(err, data) {
				if(err) return callback(err);
				if(data && data.status !== 'ZERO_RESULTS' && data.results && data.results[0]) {
					self.playerInfo.locationName = data.results[0].formatted_address;
				}

				callback(null);
			}]));
		}
	};

	/**
	 *
	 * @param req
	 * @param callback
	 */
	function api_req(req, callback) {
		if(!Array.isArray(req)) {
			req = [req];
		}

		var req_obj = {
			status_code: 2,
			request_id: self.getRequestID(),
			ms_since_last_locationfix: 100 + Math.floor(Math.random() * 900),
			requests: req,
			latitude: self.playerInfo.latitude,
			longitude: self.playerInfo.longitude,
			accuracy: self.playerInfo.altitude,
			platform_requests: []
		};

		if(self.playerInfo.authTicket && self.isAuthTicketExpired(self.playerInfo.authTicket)) {
			self.playerInfo.authTicket = null;
			self.playerInfo.accessToken = null;
		}

		var env = new RequestEnvelope(req_obj);
		if(!self.playerInfo.authTicket) {
			self.GetAccessToken(function(err, token) {
				if(err) {
					return callback(err);
				} else {
					env.auth_info = {
						provider: self.playerInfo.provider,
						token: {
							contents: token,
							unknown2: 59
						}
					};
					self.processProtobufRequest(req, env, callback);
				}
			});
		} else {
			env.auth_ticket = self.playerInfo.authTicket;

			self.signatureBuilder.setAuthTicket(self.playerInfo.authTicket);
			self.signatureBuilder.setLocation(self.playerInfo.latitude, self.playerInfo.longitude, self.playerInfo.altitude);

			self.signatureBuilder.encrypt(env.requests, function(err, sigEncrypted) {
				if(err) {
					console.log(err);
				} else {
					env.platform_requests.push(new RequestEnvelope.PlatformRequest({
						type: POGOProtos.Networking.Platform.PlatformRequestType.SEND_ENCRYPTED_SIGNATURE,
						request_message: new POGOProtos.Networking.Platform.Requests.SendEncryptedSignatureRequest({
							encrypted_signature: sigEncrypted
						}).encode()
					}));
					self.processProtobufRequest(req, env, callback);
				}
			});
		}
	}

	/**
	 *
	 * @param authTicket
	 * @returns {boolean}
	 */
	self.isAuthTicketExpired = function(authTicket) {
		var now = new Date().getTime();
		var ms_remaining = authTicket.expire_timestamp_ms.toString() - now;
		if(ms_remaining <= 0) {
			return true;
		}
		return false;
	}

	/**
	 *
	 * @param req
	 * @param data
	 * @param callback
	 */
	self.processProtobufRequest = function(req, data, callback) {
		var api_endpoint = (self.playerInfo.apiEndpoint ? self.playerInfo.apiEndpoint : api_url);

		var options = {
			url: api_endpoint,
			body: data.toBuffer(),
			encoding: null,
			headers: {
				'User-Agent': 'Niantic App'
			}
		};

		self.request.post(options, function(err, response, body) {
			if(err) {
				return callback(new Error('Error'));
			}

			if(response === undefined || body === undefined) {
				console.error('[!] RPC Server offline');
				return callback(new Error('RPC Server offline'));
			}

			var ret_obj;
			try {
				ret_obj = ResponseEnvelope.decode(body);
			} catch(e) {
				if(e.decoded) {
					// Truncated
					console.warn(e);
					ret_obj = e.decoded; // Decoded message with missing required fields
				}
			}

			if(ret_obj) {
				if(ret_obj.auth_ticket) {
					self.playerInfo.authTicket = ret_obj.auth_ticket;
					api_req(req, callback);
				} else {
					return callback(null, ret_obj);
				}
			} else {
				api_req(req, callback);
			}
		});
	}

	/**
	 *
	 * @param options		Should contain username, password, location, provider, and collect
	 * @param callback
	 * @returns {*}
	 */
	self.init = function(options, callback) {
		_username = options.username;
		_password = options.password;
		self.signatureBuilder = new pogoSignature.Builder();
		if(options.provider !== 'ptc' && options.provider !== 'google') {
			return callback(new Error('Invalid provider'));
		}

		self.playerInfo.initTime = new Date().getTime();

		// set provider
		self.playerInfo.provider = options.provider;
		// Updating location
		self.SetLocation(options.location, function(err) {
			if(err) {
				return callback(err);
			}
			// Getting access token
			self.GetAccessToken(function(err, token) {
				if(err) {
					return callback(err);
				} else {
					self.playerInfo.accessToken = token;
				}
				// Getting api endpoint
				self.GetApiEndpoint(function(err, api_endpoint) {
					if(err) {
						return callback(err);
					} else {
						self.playerInfo.apiEndpoint = api_endpoint;
					}
					// get initial heartbeat
					self.Heartbeat(function(err, res) {
						if(err) {
							return callback(err);
						} else {
							callback(null, res);
						}
					});
				});
			});
		});
	};

	/**
	 *
	 * @param callback
	 * @constructor
	 */
	self.GetAccessToken = function(callback) {
		if(self.playerInfo.accessToken === undefined || self.playerInfo.accessToken == null) {
			self.DebugPrint('[i] Logging with user: ' + _username);
			if(self.playerInfo.provider === 'ptc') {
				Logins.PokemonClub(_username, _password, self, function(err, token) {
					if(err) {
						return callback(err);
					}

					self.DebugPrint('[i] Received PTC access token!');
					callback(null, token);
				});
			} else {
				Logins.GoogleAccount(_username, _password, self, function(err, token) {
					if(err) {
						return callback(err);
					}

					self.DebugPrint('[i] Received Google access token!');
					callback(null, token);
				});
			}
		} else {
			callback(null, self.playerInfo.accessToken);
		}
	};

	/**
	 *
	 * @param callback
	 * @constructor
	 */
	self.GetApiEndpoint = function(callback) {
		var req = [
			{"request_type": RequestType.GET_PLAYER}
		];

		api_req(req, function(err, ret) {
			if(err) {
				callback(err);
			} else {
				if(ret.api_url !== undefined && ret.api_url !== null && ret.api_url.length > 0) {
					console.log(ret.api_url);
					error_count = 0;
					var api_endpoint = 'https://' + ret.api_url + '/rpc';
					self.DebugPrint('[i] Received API Endpoint: ' + api_endpoint);
					callback(null, api_endpoint);
				} else {
					error_count++;
					if(error_count >= 10) {
						callback("Failed to get an endpoint 10 times in a row");
					} else {
						setTimeout(function() {
							self.GetApiEndpoint(callback);
						}, 3000);
					}
				}
			}
		});
	};

	/**
	 *
	 * @param request_messages
	 * @param callback
	 * @constructor
	 */
	self.MakeCall = function(request_messages, callback) {
		var requests = [];
		var actions = [];
		var request_types = [];
		for(var request_type in request_messages) {
			var action = self.getActions(request_type);
			var request = {request_type: RequestType[request_type]};
			if(request_messages[request_type]) {
				request.request_message = new RequestMessages[action.message](request_messages[request_type]).encode()
			}
			requests.push(request);
			request_types.push(request_type);
			actions.push(action);
		}

		api_req(requests, function(err, ret) {
			if(err) {
				return callback(err);
			}
			var err;
			var responses = {};
			try {
				if(ret.status_code != 1 && ret.status_code != 2) {
					err = "Request failed: " + self.getObjKeyByValue(ResponseEnvelope.StatusCode, ret.status_code);
				} else {
					for(var i in ret.returns) {
						responses[request_types[i]] = Responses[actions[i].response].decode(ret.returns[i]);
					}
				}
			} catch(e) {
				err = e;
			}
			callback(err, responses);
		});
	};

	/**
	 *
	 * @param callback
	 * @constructor
	 */
	self.Heartbeat = function(callback) {
		// Generating walk data using s2 geometry
		var walk = self.GetNeighbors(self.playerInfo.latitude, self.playerInfo.longitude).sort(function(a, b) {
			return a > b;
		});

		var timestamps = new Array(walk.length);
		//timestamps.fill(Date.now());
		timestamps.fill(0);

		var requests = {
			GET_MAP_OBJECTS: {
				cell_id: walk,
				since_timestamp_ms: timestamps,
				latitude: self.playerInfo.latitude,
				longitude: self.playerInfo.longitude
			},
			GET_PLAYER: null,
			GET_HATCHED_EGGS: null,
			GET_BUDDY_WALKED: null,
			GET_INVENTORY: null,
			CHECK_AWARDED_BADGES: null,
			DOWNLOAD_SETTINGS: "54b359c97e46900f87211ef6e6dd0b7f2a3ea1f5"
		};

		self.MakeCall(requests, function(err, responses) {
			var ret = null;
			if(responses != null) {
				ret = responses;
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param fort
	 * @param callback
	 * @constructor
	 */
	self.GetFortDetails = function(fort, callback) {
		var type = "FORT_DETAILS";
		var request = {};
		request[type] = {
			fort_id: fort.id,
			latitude: fort.latitude,
			longitude: fort.longitude
		};
		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null) {
				ret = responses[type];
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param gym
	 * @param callback
	 */
	self.getGymDetails = function(gym, callback) {
		var type = "GET_GYM_DETAILS";
		var request = {};
		request[type] = {
			gym_id: gym.id,
			gym_latitude: gym.latitude,
			gym_longitude: gym.longitude,
			player_latitude: self.playerInfo.latitude,
			player_longitude: self.playerInfo.longitude
		};
		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null) {
				ret = responses[type];
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param fort
	 * @param callback
	 * @constructor
	 */
	self.GetFort = function(fort, callback) {
		var type = "FORT_SEARCH";
		var request = {};
		request[type] = {
			fort_id: fort.id,
			player_latitude: self.playerInfo.latitude,
			player_longitude: self.playerInfo.longitude,
			fort_latitude: fort.latitude,
			fort_longitude: fort.longitude
		};
		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null) {
				ret = responses[type];
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param fort
	 * @param pokemon_id
	 * @param callback
	 * @constructor
	 */
	self.FortDeployPokemon = function(fort, pokemon_id, callback) {
		var type = "FORT_DEPLOY_POKEMON";
		var request = {};
		request[type] = {
			fort_id: fort.id,
			player_latitude: self.playerInfo.latitude,
			player_longitude: self.playerInfo.longitude,
			pokemon_id: pokemon_id
		};
		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null) {
				ret = responses[type];
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param callback
	 * @constructor
	 */
	self.CollectDailyDefenderBonus = function(callback) {
		var type = "COLLECT_DAILY_DEFENDER_BONUS";
		var request = {};
		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null) {
				ret = responses[type];
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param callback
	 * @constructor
	 */
	self.GetInventory = function(callback) {
		var type = "GET_INVENTORY";
		var request = {};
		request[type] = null;
		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null) {
				if(responses[type]) {
					if(responses[type].inventory_delta.inventory_items !== undefined) {
						ret = responses[type].inventory_delta.inventory_items;
					} else {
						console.log("\t\tresponses[type].inventory_delta.inventory_items === undefined");
					}
				} else {
					console.log("\t\tresponses[type] not set");
				}
			} else {
				console.log("\t\tresponses == null");
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param callback
	 * @constructor
	 */
	self.GetProfile = function(callback) {
		var type = "GET_PLAYER";
		var request = {};
		request[type] = null;
		self.MakeCall(request, function(err, responses) {
			if(err) {
				console.log(err);
			} else {
				var ret = null;
				if(responses != null && responses[type].player_data !== undefined) {
					ret = responses[type].player_data;
				}
				callback(err, ret);
			}
		});
	};

	/**
	 *
	 * @param callback
	 * @constructor
	 */
	self.GetJournal = function(callback) {
		var type = "SFIDA_ACTION_LOG";
		var request = {};
		request[type] = null;
		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null && responses[type].log_entries !== undefined) {
				ret = responses[type].log_entries;
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param pokemonId
	 * @param callback
	 * @constructor
	 */
	self.EvolvePokemon = function(pokemonId, callback) {
		var type = "EVOLVE_POKEMON";
		var request = {};
		request[type] = {pokemon_id: pokemonId};
		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null) {
				ret = responses[type];
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param pokemonId
	 * @param callback
	 * @constructor
	 */
	self.TransferPokemon = function(pokemonId, callback) {
		var type = "RELEASE_POKEMON";
		var request = {};
		request[type] = {pokemon_id: pokemonId};
		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null) {
				ret = responses[type];
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param pokemonId
	 * @param favorite
	 * @param callback
	 * @constructor
	 */
	self.SetFavoritePokemon = function(pokemonId, favorite, callback) {
		var type = "SET_FAVORITE_POKEMON";
		var request = {};
		request[type] = {pokemon_id: pokemonId, is_favorite: true};
		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null) {
				ret = responses[type];
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param callback
	 * @constructor
	 */
	self.GetHatchedEggs = function(callback) {
		var type = "GET_HATCHED_EGGS";
		var request = {};
		request[type] = null;
		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null) {
				ret = responses[type];
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param callback
	 * @constructor
	 */
	self.GetBuddyWalked = function(callback) {
		var type = "GET_BUDDY_WALKED";
		var request = {};
		request[type] = null;
		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null) {
				ret = responses[type];
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param level
	 * @param callback
	 * @constructor
	 */
	self.GetLevelUpRewards = function(level, callback) {
		var type = "LEVEL_UP_REWARDS";
		var request = {};
		request[type] = {level: level};
		self.MakeCall(request, function(err, responses) {
			if(err) {
				console.log(err);
			} else {
				var ret = null;
				if(responses != null && responses[type] !== undefined) {
					ret = responses[type];
				}
				callback(err, ret);
			}
		});
	};

	/**
	 *
	 * @param mapPokemon
	 * @param callback
	 * @constructor
	 */
	self.EncounterPokemon = function(mapPokemon, callback) {
		var type;
		var request = {};
		if(mapPokemon.fort_id !== undefined && mapPokemon.fort_id != null) {
			type = "DISK_ENCOUNTER";
			request[type] = {
				encounter_id: mapPokemon.encounter_id,
				fort_id: mapPokemon.fort_id,
				player_latitude: self.playerInfo.latitude,
				player_longitude: self.playerInfo.longitude
			};
		} else {
			type = "ENCOUNTER";
			request[type] = {
				encounter_id: mapPokemon.encounter_id,
				spawn_point_id: mapPokemon.spawn_point_id,
				player_latitude: self.playerInfo.latitude,
				player_longitude: self.playerInfo.longitude
			};
		}
		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null) {
				ret = responses[type];
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param mapPokemon
	 * @param normalizedHitPosition
	 * @param normalizedReticleSize
	 * @param spinModifier
	 * @param pokeball
	 * @param callback
	 * @constructor
	 */
	self.CatchPokemon = function(mapPokemon, hitPokemon, normalizedHitPosition, normalizedReticleSize, spinModifier, pokeball, callback) {
		var type = "CATCH_POKEMON";
		var request = {};
		request[type] = {
			encounter_id: mapPokemon.encounter_id,
			pokeball: pokeball,
			normalized_reticle_size: normalizedReticleSize,
			hit_pokemon: hitPokemon,
			spin_modifier: spinModifier,
			normalized_hit_position: normalizedHitPosition
		};
		if(mapPokemon.fort_id !== undefined && mapPokemon.fort_id != null) {
			request[type].spawn_point_id = mapPokemon.fort_id;
		} else {
			request[type].spawn_point_id = mapPokemon.spawn_point_id;
		}

		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null) {
				ret = responses[type];
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param pokemonId
	 * @param nickname
	 * @param callback
	 * @constructor
	 */
	self.RenamePokemon = function(pokemonId, nickname, callback) {
		var type = "NICKNAME_POKEMON";
		var request = {};
		request[type] = {
			pokemon_id: pokemonId,
			nickname: nickname
		};
		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null) {
				ret = responses[type];
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param item_id
	 * @param count
	 * @param callback
	 * @constructor
	 */
	self.DropItem = function(item_id, count, callback) {
		if(count > 0) {
			var type = "RECYCLE_INVENTORY_ITEM";
			var request = {};
			request[type] = {
				item_id: item_id,
				count: count
			};
			self.MakeCall(request, function(err, responses) {
				var ret = null;
				if(responses != null) {
					ret = responses[type];
				}
				callback(err, ret);
			});
		}
	};

	/**
	 *
	 * @param pokemon
	 * @param callback
	 * @constructor
	 */
	self.ReleasePokemon = function(pokemon, callback) {
		var type = "RELEASE_POKEMON";
		var request = {};
		request[type] = {
			pokemon_id: pokemon.toString()
		};
		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null) {
				ret = responses[type];
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param level
	 * @param callback
	 * @constructor
	 */
	self.LevelUpRewards = function(level, callback) {
		var type = "LEVEL_UP_REWARDS";
		var request = {};
		request[type] = {
			level: level
		};
		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null) {
				ret = responses[type];
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param item_id
	 * @param pokemon_id
	 * @param callback
	 * @constructor
	 */
	self.UseItemEggIncubator = function(item_id, pokemon_id, callback) {
		var type = "USE_ITEM_EGG_INCUBATOR";
		var request = {};
		request[type] = {
			item_id: item_id,
			pokemon_id: pokemon_id
		};
		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null) {
				ret = responses[type];
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param callback
	 * @constructor
	 */
	self.GetHatchedEggs = function(callback) {
		var type = "GET_HATCHED_EGGS";
		var request = {};
		request[type] = null;
		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null) {
				ret = responses[type];
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param item_id
	 * @param count
	 * @param callback
	 * @constructor
	 */
	self.UseItemXpBoost = function(item_id, count, callback) {
		var type = "USE_ITEM_XP_BOOST";
		var request = {};
		request[type] = {
			item_id: item_id
		};
		self.MakeCall(request, function(err, responses) {
			var ret = null;
			if(responses != null) {
				ret = responses[type];
			}
			callback(err, ret);
		});
	};

	/**
	 *
	 * @param callback
	 * @constructor
	 */
	self.GetLocation = function(callback) {
		geocoder.reverseGeocode.apply(geocoder, self.toConsumableArray(self.GetCoords()).concat([function(err, data) {
			if(data.status === 'ZERO_RESULTS') {
				return callback(new Error('location not found'));
			}

			callback(null, data.results[0].formatted_address);
		}]));
	};

	/**
	 *
	 * @returns {*[]}
	 * @constructor
	 */
	self.GetCoords = function() {
		var latitude = self.playerInfo.latitude;
		var longitude = self.playerInfo.longitude;

		return [latitude, longitude];
	}

	/**
	 *
	 * @param lat
	 * @param lng
	 * @returns {*[]}
	 * @constructor
	 */
	self.GetNeighbors = function(lat, lng) {
		var level = 15;
		var origin = S2.latLngToKey(lat, lng, level);
		var walk = [S2.keyToId(origin)];
		// 10 before and 10 after
		var next = S2.nextKey(origin);
		var prev = S2.prevKey(origin);
		for(var i = 0; i < 10; i++) {
			// in range(10):
			walk.push(S2.toId(prev));
			walk.push(S2.toId(next));
			next = S2.nextKey(next);
			prev = S2.prevKey(prev);
		}
		return walk;
	}

	/**
	 *
	 * @param arr
	 * @returns {*}
	 */
	self.toConsumableArray = function(arr) {
		if(Array.isArray(arr)) {
			for(var i = 0, arr2 = Array(arr.length); i < arr.length; i++) {
				arr2[i] = arr[i];
			}
			return arr2;
		} else {
			return Array.from(arr);
		}
	}

	/**
	 *
	 * @returns {*}
	 */
	self.getRequestID = function() {
		var bytes = crypto.randomBytes(8);
		return Long.fromBits(
			bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3],
			bytes[4] << 24 | bytes[5] << 16 | bytes[6] << 8 | bytes[7],
			true
		);
	};

	/**
	 * Get item info
	 *
	 * @param item
	 * @returns {{}}
	 */
	self.getItemInfo = function(item) {
		var item_info = {};
		if(item === undefined) {
			throw "item not defined in getItemInfo";
		}
		item_info.name = self.getObjKeyByValue(POGOProtos.Inventory.Item.ItemId, item.item_id);
		if(!item_info.name) {
			item_info.name = "UNKNOWN ITEM (" + item.item_id + ")";
		} else {
			item_info.name = item_info.name.replace(/item /ig, "");
		}

		return item_info;
	}

	/**
	 *
	 * @param pokemon
	 * @returns {{}}
	 */
	self.getPokemonInfo = function(pokemon) {
		var pokemon_info = {};
		if(pokemon === undefined) {
			throw "pokemon not defined in getPokemonInfo";
		}
		/**
		 * TODO: figure out types...
		 "type": "Grass / Poison",
		 */
		pokemon_info.name = self.getObjKeyByValue(POGOProtos.Enums.PokemonId, pokemon.pokemon_id);
		if(!pokemon_info.name) {
			pokemon_info.name = "UNKNOWN POKEMON (" + pokemon.pokemon_id + ")";
		}

		return pokemon_info;
	}

	/**
	 *
	 * @param pokemon_family_id
	 * @returns {*}
	 */
	self.getPokemonFamilyName = function(pokemon_family_id) {
		var pokemon_family;
		if(pokemon_family_id === undefined) {
			throw "pokemon_family_id not defined in getPokemonFamilyName";
		}

		pokemon_family = self.getObjKeyByValue(POGOProtos.Enums.PokemonFamilyId, pokemon_family_id);
		if(!pokemon_family) {
			pokemon_family = "UNKNOWN POKEMON FAMILY (" + pokemon_family_id + ")";
		} else {
			pokemon_family = pokemon_family.replace(/family /ig, "");
		}

		return pokemon_family;
	}

	/**
	 *
	 * @param status_id
	 * @returns {*}
	 */
	self.getCatchStatus = function(status_id) {
		var status;
		if(status_id === undefined) {
			throw "status_id not defined in getCatchStatus";
		}

		status = self.getObjKeyByValue(Responses.CatchPokemonResponse.CatchStatus, status_id);

		return status;
	}

	/**
	 *
	 * @param status_id
	 * @returns {*}
	 */
	self.getEncounterStatus = function(status_id) {
		var status;
		if(status_id === undefined) {
			throw "status_id not defined in getEncounterStatus";
		}

		status = self.getObjKeyByValue(Responses.EncounterResponse.Status, status_id);

		return status;
	}

	/**
	 *
	 * @param result_id
	 * @returns {*}
	 */
	self.getDiskEncounterResult = function(result_id) {
		var result;
		if(result_id === undefined) {
			throw "result_id not defined in getDiskEncounterResult";
		}

		result = self.getObjKeyByValue(Responses.DiskEncounterResponse.Result, result_id);

		return result;
	}

	/**
	 *
	 * @param result_id
	 * @returns {*}
	 */
	self.getRecycleItemResult = function(result_id) {
		var result;
		if(result_id === undefined) {
			throw "result_id not defined in getRecycleItemResult";
		}

		result = self.getObjKeyByValue(Responses.RecycleInventoryItemResponse.Result, result_id);

		if(!result) {
			result = "UNKNOWN RECYCLE ITEM RESULT (" + result_id + ")";
		}

		return result;
	}

	/**
	 *
	 * @param result_id
	 * @returns {*}
	 */
	self.getFortSearchResult = function(result_id) {
		var result;
		if(result_id === undefined) {
			throw "result_id not defined in getFortSearchResult";
		}

		result = self.getObjKeyByValue(Responses.FortSearchResponse.Result, result_id);

		return result;
	}

	/**
	 *
	 * @param result_id
	 * @returns {*}
	 */
	self.getFortDeployPokemonResult = function(result_id) {
		var result;
		if(result_id === undefined) {
			throw "result_id not defined in getFortDeployPokemonResult";
		}

		result = self.getObjKeyByValue(Responses.FortDeployPokemonResponse.Result, result_id);

		return result;
	}

	/**
	 *
	 * @param result_id
	 * @returns {*}
	 */
	self.getCollectDailyDefenderBonusResult = function(result_id) {
		var result;
		if(result_id === undefined) {
			throw "result_id not defined in getCollectDailyDefenderBonusResult";
		}

		result = self.getObjKeyByValue(Responses.CollectDailyDefenderBonusResponse.Result, result_id);

		return result;
	}

	/**
	 *
	 * @param result_id
	 * @returns {*}
	 */
	self.getUseItemEggIncubatorResult = function(result_id) {
		var result;
		if(result_id === undefined) {
			throw "result_id not defined in getUseItemEggIncubatorResult";
		}

		result = self.getObjKeyByValue(Responses.UseItemEggIncubatorResponse.Result, result_id);

		return result;
	}

	/**
	 *
	 * @param result_id
	 * @returns {*}
	 */
	self.getLevelUpRewardsResult = function(result_id) {
		var result;
		if(result_id === undefined) {
			throw "result_id not defined in getLevelUpRewardsResult";
		}

		result = self.getObjKeyByValue(Responses.LevelUpRewardsResponse.Result, result_id);

		return result;
	}

	/**
	 *
	 * @param badge_type_id
	 * @returns {*}
	 */
	self.getBadgeType = function(badge_type_id) {
		var badge_type;
		if(badge_type_id === undefined) {
			throw "badge_type_id not defined in getBadgeType";
		}

		badge_type = self.getObjKeyByValue(POGOProtos.Enums.BadgeType, badge_type_id);
		if(!badge_type) {
			badge_type = "UNKNOWN BADGE TYPE (" + badge_type_id + ")";
		} else {
			badge_type = badge_type.replace(/badge /ig, "");
		}

		return badge_type;
	}

	/**
	 *
	 * @returns {number}
	 */
	self.getMaxPokemonNameLength = function() {
		var max_len = 0;
		if(self.max_pokemon_name_len == null) {
			for(var i in POGOProtos.Enums.PokemonId) {
				if(i.length > max_len) {
					max_len = i.length;
				}
			}
		} else {
			max_len = self.max_pokemon_name_len;
		}

		return max_len;
	}

	/**
	 *
	 * @param property
	 * @returns {Function}
	 */
	self.dynamicSort = function(property) {
		var sortOrder = 1;
		if(property[0] === "-") {
			sortOrder = -1;
			property = property.substr(1);
		}
		return function(a, b) {
			var result = (a[property] < b[property]) ? -1 : (a[property] > b[property]) ? 1 : 0;
			return result * sortOrder;
		}
	}

	/**
	 *
	 * @returns {Function}
	 */
	self.dynamicSortMultiple = function() {
		/*
		 * save the arguments object as it will be overwritten
		 * note that arguments object is an array-like object
		 * consisting of the names of the properties to sort by
		 */
		var props = arguments;
		return function(obj1, obj2) {
			var i = 0, result = 0, numberOfProperties = props.length;
			/* try getting a different result from 0 (equal)
			 * as long as we have extra properties to compare
			 */
			while(result === 0 && i < numberOfProperties) {
				result = self.dynamicSort(props[i])(obj1, obj2);
				i++;
			}
			return result;
		}
	}

	/**
	 *
	 * @param locations
	 * @param callback
	 */
	self.sortLocations = function(locations, callback) {
		locations.sort(self.dynamicSortMultiple("latitude", "longitude"));
		callback(locations);
	}
}

module.exports = PokemonGoAPI;
