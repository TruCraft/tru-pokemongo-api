#! /usr/bin/env node

var PokemonGoAPI = require("./");

var username = "username";
var password = "password";
var provider = "google";

var location = {"type": "coords", "coords": {"latitude": 40.758843, "longitude": -73.985131, "altitude": 0}};

var pokeAPI = new PokemonGoAPI();

pokeAPI.init(username, password, location, provider, function(err) {
  if(err) {
    console.log(err);
  } else {
    console.log('Current location: ' + pokeAPI.playerInfo.locationName);
    console.log('lat/long/alt: : ' + pokeAPI.playerInfo.latitude + ' ' + pokeAPI.playerInfo.longitude + ' ' + pokeAPI.playerInfo.altitude);

    pokeAPI.GetProfile(function(err, profile) {
      if(err) {
        console.log(err);
      } else {
        poke_storage = profile.max_pokemon_storage;
        item_storage = profile.max_item_storage;
        console.log('Username: ' + profile.username);
        console.log('Poke Storage: ' + poke_storage);
        console.log('Item Storage: ' + item_storage);

        console.log('Pokecoin: ' + profile.currencies[0].amount);
        console.log('Stardust: ' + profile.currencies[1].amount);
      }
    });

    /*pokeAPI.GetInventory(function(err, ret) {
      if(err) {
        console.log(err);
      } else {
        for(var i in ret) {
          // player_stats
          if(ret[i].inventory_item_data.player_stats !== undefined || ret[i].inventory_item_data.player_stats != null) {
            console.log(ret[i].inventory_item_data);
          }
          // candy - candy counts by pokemon family
          if(ret[i].inventory_item_data.candy !== undefined || ret[i].inventory_item_data.candy != null) {
            console.log(ret[i].inventory_item_data.candy);
          }
          // pokedex_entry - status of pokemon in pokedex (captures, encounters, etc)
          if(ret[i].inventory_item_data.pokedex_entry !== undefined || ret[i].inventory_item_data.pokedex_entry != null) {
            console.log(ret[i].inventory_item_data.pokedex_entry);
          }
          // pokemon_data - pokemon list
          if(ret[i].inventory_item_data.pokemon_data !== undefined || ret[i].inventory_item_data.pokemon_data != null) {
            console.log(ret[i].inventory_item_data.pokemon_data);
          }
        }
      }
    });*/

    /*pokeAPI.GetJournal(function(err, ret) {
      if(err) {
        console.log(err);
      } else {
        console.log(ret);
      }
    });*/
  }
});
