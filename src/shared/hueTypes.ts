/**
 * The subset of the Hue CLIP v2 resource model that BrightBulb reads.
 * Fields are optional wherever the bridge omits them for some product or
 * firmware, so selectors must not assume their presence.
 */
export namespace Clip {
  export interface ResourceRef {
    rid: string;
    rtype: string;
  }

  export interface XY {
    x: number;
    y: number;
  }

  export interface Resource {
    id: string;
    type: string;
    id_v1?: string;
    owner?: ResourceRef;
    [key: string]: unknown;
  }

  export interface Light extends Resource {
    type: "light";
    metadata?: { name?: string; archetype?: string };
    on?: { on: boolean };
    dimming?: { brightness: number; min_dim_level?: number };
    color?: {
      xy?: XY;
      gamut?: { red: XY; green: XY; blue: XY };
      gamut_type?: string;
    };
    color_temperature?: {
      mirek: number | null;
      mirek_valid?: boolean;
      mirek_schema?: { mirek_minimum: number; mirek_maximum: number };
    };
  }

  export interface Group extends Resource {
    type: "room" | "zone";
    metadata?: { name?: string; archetype?: string };
    children?: ResourceRef[];
    services?: ResourceRef[];
  }

  export interface Device extends Resource {
    type: "device";
    metadata?: { name?: string; archetype?: string };
    services?: ResourceRef[];
  }

  export interface ZigbeeConnectivity extends Resource {
    type: "zigbee_connectivity";
    status?: string;
  }

  export interface GroupedLight extends Resource {
    type: "grouped_light";
    on?: { on: boolean };
    dimming?: { brightness: number };
  }

  export interface SceneAction {
    target: ResourceRef;
    action: {
      on?: { on: boolean };
      dimming?: { brightness: number };
      color?: { xy: XY };
      color_temperature?: { mirek: number | null };
    };
  }

  export interface Scene extends Resource {
    type: "scene";
    metadata?: { name?: string };
    group?: ResourceRef;
    actions?: SceneAction[];
    palette?: {
      color?: { color: { xy: XY }; dimming?: { brightness: number } }[];
      color_temperature?: { color_temperature: { mirek: number }; dimming?: { brightness: number } }[];
    };
    status?: { active?: string };
  }

  export interface EntertainmentChannel {
    channel_id: number;
    position?: { x: number | null; y: number | null; z: number | null };
  }

  export interface EntertainmentConfiguration extends Resource {
    type: "entertainment_configuration";
    metadata?: { name?: string };
    name?: string;
    configuration_type?: string;
    status?: string;
    active_streamer?: ResourceRef | null;
    channels?: EntertainmentChannel[];
  }

  export interface Bridge extends Resource {
    type: "bridge";
    bridge_id?: string;
  }

  /**
   * One message on `/eventstream/clip/v2`. `data` holds partial resources.
   */
  export interface Event {
    id?: string;
    creationtime?: string;
    type: "add" | "update" | "delete" | "error";
    data: Resource[];
  }

  /**
   * Envelope of every CLIP v2 REST response.
   */
  export interface Response<T = Resource> {
    errors?: { description: string }[];
    data?: T[];
  }
}

export default Clip;
